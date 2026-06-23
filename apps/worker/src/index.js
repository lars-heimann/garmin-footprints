const RESERVED_SLUGS = new Set(["www", "api", "admin", "static", "assets", "login", "support"]);
const ALLOWED_ASSETS = new Set(["index.html", "app.js", "styles.css", "meta.json", "points.bin"]);
const DEFAULT_MAX_ZIP_BYTES = 500 * 1024 * 1024;
const DEFAULT_START_DATE = "2022-05-01";
const DEFAULT_MAX_POINTS = 900_000;

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
};

export async function handleRequest(request, env, ctx = { waitUntil() {} }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const url = new URL(request.url);
  try {
    if (url.pathname.startsWith("/api/processor/")) {
      return withCors(await handleProcessorRoute(request, env, url));
    }
    if (url.pathname.startsWith("/api/")) {
      return withCors(await handleApiRoute(request, env, ctx, url));
    }

    const siteSlug = slugFromHost(request.headers.get("Host") || url.host, env.PUBLIC_HOST_SUFFIX);
    if (siteSlug) {
      return await serveGeneratedSite(request, env, siteSlug);
    }

    if (env.ASSETS?.fetch) {
      return env.ASSETS.fetch(request);
    }
    return htmlResponse("Garmin Footprints API");
  } catch (error) {
    console.error(JSON.stringify({ level: "error", message: String(error), stack: error?.stack }));
    return withCors(errorResponse("INTERNAL_ERROR", "Unexpected server error.", 500));
  }
}

async function handleApiRoute(request, env, ctx, url) {
  if (request.method === "POST" && url.pathname === "/api/upload-sessions") {
    return createUploadSession(request, env);
  }

  const uploadMatch = url.pathname.match(/^\/api\/uploads\/([^/]+)$/);
  if (request.method === "PUT" && uploadMatch) {
    return receiveUpload(request, env, ctx, uploadMatch[1], url.searchParams.get("token"));
  }

  const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (request.method === "GET" && jobMatch) {
    return getPublicJob(env, jobMatch[1]);
  }

  return errorResponse("NOT_FOUND", "Route not found.", 404);
}

async function handleProcessorRoute(request, env, url) {
  if (!(await isProcessorAuthorized(request, env))) {
    return errorResponse("UNAUTHORIZED", "Processor token is missing or invalid.", 401);
  }

  const match = url.pathname.match(/^\/api\/processor\/jobs\/([^/]+)(?:\/(.*))?$/);
  if (!match) {
    return errorResponse("NOT_FOUND", "Processor route not found.", 404);
  }

  const jobId = match[1];
  const action = match[2] || "";
  const store = getStore(env);
  const job = await store.getJob(jobId);
  if (!job) {
    return errorResponse("JOB_NOT_FOUND", "Job was not found.", 404);
  }

  if (request.method === "GET" && action === "") {
    return jsonResponse(processorJobConfig(job, env));
  }

  if (request.method === "POST" && action === "start") {
    if (!["queued", "uploaded"].includes(job.status)) {
      return errorResponse("INVALID_STATUS", "Job is not queued for processing.", 409);
    }
    const now = new Date().toISOString();
    await store.updateJob(jobId, { status: "processing", updatedAt: now });
    return jsonResponse({ jobId, status: "processing" });
  }

  if (request.method === "GET" && action === "download") {
    if (!job.uploadKey) {
      return errorResponse("UPLOAD_NOT_FOUND", "Job does not have an upload.", 404);
    }
    const object = await getBucket(env).get(job.uploadKey);
    if (!object) {
      return errorResponse("UPLOAD_NOT_FOUND", "Raw upload was not found.", 404);
    }
    return objectResponse(object, "application/zip");
  }

  const assetMatch = action.match(/^assets\/([^/]+)$/);
  if (request.method === "PUT" && assetMatch) {
    if (job.status !== "processing") {
      return errorResponse("INVALID_STATUS", "Job must be processing before assets can be uploaded.", 409);
    }
    const assetName = assetMatch[1];
    if (!ALLOWED_ASSETS.has(assetName)) {
      return errorResponse("INVALID_ASSET", "Asset name is not allowed.", 400);
    }
    await getBucket(env).put(`sites/${job.slug}/${assetName}`, request.body, {
      httpMetadata: { contentType: contentTypeForPath(assetName) },
    });
    return jsonResponse({ ok: true });
  }

  if (request.method === "POST" && action === "complete") {
    const payload = await request.json().catch(() => ({}));
    return completeJob(env, job, payload);
  }

  return errorResponse("NOT_FOUND", "Processor route not found.", 404);
}

async function createUploadSession(request, env) {
  const payload = await request.json().catch(() => null);
  if (!payload) {
    return errorResponse("INVALID_JSON", "Request body must be JSON.", 400);
  }

  const slug = normalizeSlug(payload.slug);
  if (!isValidSlug(slug)) {
    return errorResponse("INVALID_SLUG", "Use 3-40 lowercase letters, numbers, or hyphens.", 400);
  }

  const inviteCode = normalizeInviteCode(payload.inviteCode);
  if (!inviteCode) {
    return errorResponse("INVALID_INVITE", "Invite code is required.", 400);
  }

  const store = getStore(env);
  const now = new Date().toISOString();
  const inviteHash = await hashInviteCode(inviteCode, inviteSecret(env));
  const invite = await store.getInviteByHash(inviteHash);
  if (!invite) {
    return errorResponse("INVALID_INVITE", "Invite code was not found.", 403);
  }

  const consumed = await store.incrementInviteUse(inviteHash);
  if (!consumed) {
    return errorResponse("INVITE_EXHAUSTED", "Invite code has no remaining uses.", 403);
  }

  const jobId = crypto.randomUUID();
  const reserved = await store.reserveSlug(slug, jobId, now);
  if (!reserved) {
    await store.decrementInviteUse(inviteHash);
    return errorResponse("SLUG_TAKEN", "That slug is already reserved.", 409);
  }

  const displayName = cleanDisplayName(payload.displayName);
  const startDate = cleanStartDate(payload.startDate || env.DEFAULT_START_DATE || DEFAULT_START_DATE);
  const maxPoints = cleanMaxPoints(payload.maxPoints || env.DEFAULT_MAX_POINTS || DEFAULT_MAX_POINTS);
  const siteUrl = siteUrlForSlug(slug, env);
  const uploadToken = await signUploadToken(env, { jobId, exp: Date.now() + 60 * 60 * 1000 });
  const uploadUrl = new URL(`/api/uploads/${jobId}`, request.url);
  uploadUrl.searchParams.set("token", uploadToken);

  await store.createJob({
    jobId,
    slug,
    displayName,
    status: "reserved",
    inviteCodeHash: inviteHash,
    createdAt: now,
    updatedAt: now,
    errorCode: null,
    errorMessage: null,
    siteUrl,
    rawUploadDeletedAt: null,
    uploadKey: `uploads/${jobId}/garmin-export.zip`,
    startDate,
    maxPoints,
  });

  return jsonResponse({
    jobId,
    slug,
    status: "reserved",
    uploadUrl: uploadUrl.toString(),
    maxZipBytes: maxZipBytes(env),
    siteUrl,
  });
}

async function receiveUpload(request, env, ctx, jobId, token) {
  if (!token) {
    return errorResponse("MISSING_UPLOAD_TOKEN", "Upload token is required.", 401);
  }
  const tokenPayload = await verifyUploadToken(env, token);
  if (!tokenPayload || tokenPayload.jobId !== jobId) {
    return errorResponse("INVALID_UPLOAD_TOKEN", "Upload token is invalid or expired.", 401);
  }

  const contentLength = Number(request.headers.get("Content-Length") || "");
  if (!Number.isFinite(contentLength) || contentLength <= 0) {
    return errorResponse("LENGTH_REQUIRED", "Content-Length is required.", 411);
  }
  if (contentLength > maxZipBytes(env)) {
    return errorResponse("ZIP_TOO_LARGE", "ZIP is larger than the configured limit.", 413);
  }
  if (!request.body) {
    return errorResponse("EMPTY_UPLOAD", "Upload body is required.", 400);
  }

  const store = getStore(env);
  const job = await store.getJob(jobId);
  if (!job) {
    return errorResponse("JOB_NOT_FOUND", "Job was not found.", 404);
  }
  if (job.status !== "reserved") {
    return errorResponse("INVALID_STATUS", "Job is not waiting for upload.", 409);
  }

  await getBucket(env).put(job.uploadKey, request.body, {
    httpMetadata: { contentType: "application/zip" },
  });
  const now = new Date().toISOString();
  await store.updateJob(jobId, { status: "queued", updatedAt: now });

  const trigger = triggerProcessor(env, jobId).catch((error) => {
    console.error(JSON.stringify({ level: "error", message: "processor trigger failed", detail: String(error) }));
  });
  ctx.waitUntil(trigger);

  return jsonResponse({ jobId, status: "queued" });
}

async function getPublicJob(env, jobId) {
  const job = await getStore(env).getJob(jobId);
  if (!job) {
    return errorResponse("JOB_NOT_FOUND", "Job was not found.", 404);
  }
  return jsonResponse({
    jobId: job.jobId,
    slug: job.slug,
    status: job.status,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    siteUrl: job.status === "ready" ? job.siteUrl : null,
    rawUploadDeletedAt: job.rawUploadDeletedAt,
  });
}

async function completeJob(env, job, payload) {
  const status = payload.status;
  if (!["ready", "failed"].includes(status)) {
    return errorResponse("INVALID_STATUS", "Completion status must be ready or failed.", 400);
  }

  const now = new Date().toISOString();
  let rawUploadDeletedAt = job.rawUploadDeletedAt;
  if (job.uploadKey && !rawUploadDeletedAt) {
    await getBucket(env).delete(job.uploadKey);
    rawUploadDeletedAt = now;
  }

  const patch =
    status === "ready"
      ? {
          status: "ready",
          updatedAt: now,
          errorCode: null,
          errorMessage: null,
          rawUploadDeletedAt,
          siteUrl: job.siteUrl || siteUrlForSlug(job.slug, env),
        }
      : {
          status: "failed",
          updatedAt: now,
          errorCode: String(payload.errorCode || "PROCESSING_FAILED"),
          errorMessage: String(payload.errorMessage || "Processing failed."),
          rawUploadDeletedAt,
        };
  await getStore(env).updateJob(job.jobId, patch);
  return jsonResponse({ jobId: job.jobId, status, rawUploadDeletedAt });
}

async function serveGeneratedSite(request, env, slug) {
  const url = new URL(request.url);
  const path = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  if (!ALLOWED_ASSETS.has(path)) {
    return new Response("Not found", { status: 404 });
  }
  const object = await getBucket(env).get(`sites/${slug}/${path}`);
  if (!object) {
    return new Response("Not found", { status: 404 });
  }
  const response = objectResponse(object, contentTypeForPath(path));
  response.headers.set("Cache-Control", path === "index.html" ? "public, max-age=60" : "public, max-age=31536000");
  return response;
}

function processorJobConfig(job, env) {
  return {
    jobId: job.jobId,
    slug: job.slug,
    displayName: job.displayName,
    siteUrl: job.siteUrl || siteUrlForSlug(job.slug, env),
    startDate: job.startDate || env.DEFAULT_START_DATE || DEFAULT_START_DATE,
    maxPoints: Number(job.maxPoints || env.DEFAULT_MAX_POINTS || DEFAULT_MAX_POINTS),
  };
}

async function triggerProcessor(env, jobId) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) {
    return;
  }
  const workflow = env.GITHUB_WORKFLOW || "process-job.yml";
  const branch = env.GITHUB_REF || "main";
  const response = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${workflow}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "garmin-footprints-worker",
      },
      body: JSON.stringify({ ref: branch, inputs: { jobId } }),
    }
  );
  if (!response.ok) {
    throw new Error(`GitHub workflow dispatch failed with ${response.status}`);
  }
}

class D1Store {
  constructor(db) {
    if (!db) {
      throw new Error("DB binding is required.");
    }
    this.db = db;
  }

  async getInviteByHash(hash) {
    return this.db.prepare("SELECT code_hash AS codeHash, max_uses AS maxUses, uses FROM invites WHERE code_hash = ?")
      .bind(hash)
      .first();
  }

  async incrementInviteUse(hash) {
    const result = await this.db
      .prepare("UPDATE invites SET uses = uses + 1 WHERE code_hash = ? AND uses < max_uses")
      .bind(hash)
      .run();
    return Number(result.meta?.changes || 0) === 1;
  }

  async decrementInviteUse(hash) {
    await this.db.prepare("UPDATE invites SET uses = MAX(uses - 1, 0) WHERE code_hash = ?").bind(hash).run();
  }

  async reserveSlug(slug, jobId, createdAt) {
    try {
      await this.db.prepare("INSERT INTO slugs (slug, job_id, created_at) VALUES (?, ?, ?)").bind(slug, jobId, createdAt).run();
      return true;
    } catch (error) {
      if (String(error).toLowerCase().includes("unique")) {
        return false;
      }
      throw error;
    }
  }

  async createJob(job) {
    await this.db
      .prepare(
        `INSERT INTO jobs (
          job_id, slug, display_name, status, invite_code_hash, created_at, updated_at,
          upload_key, error_code, error_message, site_url, raw_upload_deleted_at, start_date, max_points
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        job.jobId,
        job.slug,
        job.displayName,
        job.status,
        job.inviteCodeHash,
        job.createdAt,
        job.updatedAt,
        job.uploadKey,
        job.errorCode,
        job.errorMessage,
        job.siteUrl,
        job.rawUploadDeletedAt,
        job.startDate,
        job.maxPoints
      )
      .run();
  }

  async getJob(jobId) {
    const row = await this.db
      .prepare(
        `SELECT
          job_id AS jobId, slug, display_name AS displayName, status,
          invite_code_hash AS inviteCodeHash, created_at AS createdAt, updated_at AS updatedAt,
          upload_key AS uploadKey, error_code AS errorCode, error_message AS errorMessage,
          site_url AS siteUrl, raw_upload_deleted_at AS rawUploadDeletedAt,
          start_date AS startDate, max_points AS maxPoints
        FROM jobs WHERE job_id = ?`
      )
      .bind(jobId)
      .first();
    return row || null;
  }

  async updateJob(jobId, patch) {
    const columns = {
      status: "status",
      updatedAt: "updated_at",
      uploadKey: "upload_key",
      errorCode: "error_code",
      errorMessage: "error_message",
      siteUrl: "site_url",
      rawUploadDeletedAt: "raw_upload_deleted_at",
    };
    const entries = Object.entries(patch).filter(([key]) => columns[key]);
    if (!entries.length) return;
    const assignments = entries.map(([key]) => `${columns[key]} = ?`).join(", ");
    const values = entries.map(([, value]) => value);
    await this.db.prepare(`UPDATE jobs SET ${assignments} WHERE job_id = ?`).bind(...values, jobId).run();
  }
}

function getStore(env) {
  return env.__TEST_STORE || new D1Store(env.DB);
}

function getBucket(env) {
  const bucket = env.__TEST_BUCKET || env.SITE_BUCKET;
  if (!bucket) {
    throw new Error("SITE_BUCKET binding is required.");
  }
  return bucket;
}

function normalizeInviteCode(value) {
  return String(value || "").trim().replace(/\s+/g, "").toUpperCase();
}

function normalizeSlug(value) {
  return String(value || "").trim().toLowerCase();
}

function isValidSlug(slug) {
  return /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(slug) && !RESERVED_SLUGS.has(slug);
}

function cleanDisplayName(value) {
  return String(value || "").trim().slice(0, 80);
}

function cleanStartDate(value) {
  const text = String(value || DEFAULT_START_DATE).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : DEFAULT_START_DATE;
}

function cleanMaxPoints(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_POINTS;
  return Math.max(1_000, Math.min(2_000_000, Math.floor(parsed)));
}

function maxZipBytes(env) {
  const configured = Number(env.MAX_ZIP_BYTES || DEFAULT_MAX_ZIP_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_ZIP_BYTES;
}

function inviteSecret(env) {
  return env.INVITE_HASH_SECRET || env.UPLOAD_TOKEN_SECRET || "local-invite-secret";
}

function uploadSecret(env) {
  return env.UPLOAD_TOKEN_SECRET || env.PROCESSOR_TOKEN || "local-upload-secret";
}

function siteUrlForSlug(slug, env) {
  if (env.PUBLIC_SITE_URL_PATTERN) {
    return String(env.PUBLIC_SITE_URL_PATTERN).replaceAll("{slug}", slug);
  }
  return `https://${slug}.${env.PUBLIC_HOST_SUFFIX || "runs.example.com"}`;
}

function slugFromHost(hostHeader, suffix = "runs.example.com") {
  const host = hostHeader.split(":")[0].toLowerCase();
  const normalizedSuffix = String(suffix || "runs.example.com").toLowerCase();
  if (!host.endsWith(`.${normalizedSuffix}`)) return null;
  const slug = host.slice(0, -normalizedSuffix.length - 1);
  if (slug.includes(".") || !isValidSlug(slug)) return null;
  return slug;
}

export async function hashInviteCode(inviteCode, secret) {
  const input = normalizeInviteCode(inviteCode);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input));
  return bytesToBase64url(new Uint8Array(signature));
}

async function signUploadToken(env, payload) {
  const encodedPayload = bytesToBase64url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await hmacBytes(uploadSecret(env), encodedPayload);
  return `${encodedPayload}.${bytesToBase64url(signature)}`;
}

async function verifyUploadToken(env, token) {
  const [encodedPayload, encodedSignature] = String(token).split(".");
  if (!encodedPayload || !encodedSignature) return null;
  const expected = await hmacBytes(uploadSecret(env), encodedPayload);
  if (!constantTimeEqual(base64urlToBytes(encodedSignature), expected)) {
    return null;
  }
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(encodedPayload)));
    if (!payload.exp || Number(payload.exp) < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

async function hmacBytes(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

async function isProcessorAuthorized(request, env) {
  const expected = env.PROCESSOR_TOKEN;
  if (!expected) return false;
  const provided = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  return constantTimeEqual(new TextEncoder().encode(provided), new TextEncoder().encode(expected));
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) {
    let mismatch = left.length ^ right.length;
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      mismatch |= (left[index] || 0) ^ (right[index] || 0);
    }
    return false;
  }
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left[index] ^ right[index];
  }
  return mismatch === 0;
}

function bytesToBase64url(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64urlToBytes(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function htmlResponse(text, status = 200) {
  return new Response(`<!doctype html><title>Garmin Footprints</title><p>${escapeHtml(text)}</p>`, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function errorResponse(errorCode, errorMessage, status) {
  return jsonResponse({ errorCode, errorMessage }, status);
}

function withCors(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders())) {
    headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
  };
}

function objectResponse(object, fallbackContentType) {
  const headers = new Headers();
  if (typeof object.writeHttpMetadata === "function") {
    object.writeHttpMetadata(headers);
  }
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", fallbackContentType);
  }
  return new Response(object.body, { headers });
}

function contentTypeForPath(path) {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".bin")) return "application/octet-stream";
  return "application/octet-stream";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return entities[char];
  });
}
