const RESERVED_SLUGS = new Set([
  "www",
  "api",
  "admin",
  "static",
  "assets",
  "login",
  "support",
  "guide",
  "garmin",
  "connect",
  "processor",
  "uploads",
  "jobs",
]);
const ALLOWED_ASSETS = new Set(["index.html", "app.js", "styles.css", "meta.json", "points.bin"]);
const DEFAULT_MAX_ZIP_BYTES = 100 * 1024 * 1024;
const DEFAULT_START_DATE = "2022-05-01";
const DEFAULT_MAX_POINTS = 900_000;
const DEFAULT_PUBLIC_HOST_SUFFIX = "runmaps.larsheimann.com";
const RESERVED_JOB_TTL_MS = 60 * 60 * 1000;
const QUEUED_JOB_TTL_MS = 30 * 60 * 1000;
const PROCESSING_JOB_TTL_MS = 2 * 60 * 60 * 1000;

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(reapStaleJobs(env));
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
      if (url.pathname === "/guide/garmin-export") {
        const assetUrl = new URL(request.url);
        assetUrl.pathname = "/guide/garmin-export.html";
        return withSecurityHeaders(await env.ASSETS.fetch(new Request(assetUrl.toString(), request)));
      }
      return withSecurityHeaders(await env.ASSETS.fetch(request));
    }
    return htmlResponse("Garmin Footprints API");
  } catch (error) {
    console.error(JSON.stringify({ level: "error", message: String(error), stack: error?.stack }));
    return withCors(errorResponse("INTERNAL_ERROR", "Unexpected server error.", 500));
  }
}

async function handleApiRoute(request, env, ctx, url) {
  if (request.method === "GET" && url.pathname === "/api/config") {
    return jsonResponse({
      turnstileSiteKey: env.TURNSTILE_SITE_KEY || null,
      maxZipBytes: maxZipBytes(env),
      publicHostSuffix: env.PUBLIC_HOST_SUFFIX || DEFAULT_PUBLIC_HOST_SUFFIX,
    });
  }

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

  if (request.method === "POST" && url.pathname === "/api/processor/reap") {
    return jsonResponse(await reapStaleJobs(env));
  }

  const match = url.pathname.match(/^\/api\/processor\/jobs\/([^/]+)(?:\/(.*))?$/);
  if (!match) {
    return errorResponse("NOT_FOUND", "Processor route not found.", 404);
  }

  const jobId = match[1];
  if (!isValidJobId(jobId)) {
    return errorResponse("INVALID_JOB_ID", "Job ID is invalid.", 400);
  }
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
    const contentLength = Number(request.headers.get("Content-Length") || "");
    if (!Number.isFinite(contentLength) || contentLength <= 0) {
      return errorResponse("LENGTH_REQUIRED", "Content-Length is required.", 411);
    }
    if (contentLength > maxAssetBytes(assetName)) {
      return errorResponse("ASSET_TOO_LARGE", "Generated asset is larger than allowed.", 413);
    }
    if (!request.body) {
      return errorResponse("EMPTY_UPLOAD", "Asset body is required.", 400);
    }
    try {
      await getBucket(env).put(
        `sites/${job.slug}/${assetName}`,
        limitStreamBytes(request.body, maxAssetBytes(assetName), "ASSET_TOO_LARGE"),
        {
          httpMetadata: { contentType: contentTypeForPath(assetName) },
        }
      );
    } catch (error) {
      if (isStreamLimitError(error, "ASSET_TOO_LARGE")) {
        await getBucket(env)
          .delete(`sites/${job.slug}/${assetName}`)
          .catch(() => {});
        return errorResponse("ASSET_TOO_LARGE", "Generated asset is larger than allowed.", 413);
      }
      throw error;
    }
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
  const turnstile = await verifyTurnstile(request, env, payload.turnstileToken);
  if (!turnstile.ok) {
    return errorResponse(turnstile.code, turnstile.message, turnstile.status);
  }

  const store = getStore(env);
  const now = new Date().toISOString();
  const inviteHash = await hashInviteCode(inviteCode, inviteSecret(env));
  const invite = await store.getInviteByHash(inviteHash);
  if (!invite) {
    return errorResponse("INVALID_INVITE", "Invite code was not found.", 403);
  }
  if (Number(invite.uses || 0) >= Number(invite.maxUses || 0)) {
    return errorResponse("INVITE_EXHAUSTED", "Invite code has no remaining uses.", 403);
  }

  const jobId = crypto.randomUUID();
  const reserved = await store.reserveSlug(slug, jobId, now);
  if (!reserved) {
    return errorResponse("SLUG_TAKEN", "That slug is already reserved.", 409);
  }

  const displayName = cleanDisplayName(payload.displayName);
  const startDate = cleanStartDate(payload.startDate || env.DEFAULT_START_DATE || DEFAULT_START_DATE);
  const maxPoints = cleanMaxPoints(payload.maxPoints || env.DEFAULT_MAX_POINTS || DEFAULT_MAX_POINTS);
  const siteUrl = siteUrlForSlug(slug, env);
  const uploadToken = await signUploadToken(env, {
    jobId,
    jti: crypto.randomUUID(),
    exp: Date.now() + 60 * 60 * 1000,
  });
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
  if (!isValidJobId(jobId)) {
    return errorResponse("INVALID_JOB_ID", "Job ID is invalid.", 400);
  }
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

  const consumed = await store.incrementInviteUse(job.inviteCodeHash);
  if (!consumed) {
    const now = new Date().toISOString();
    await store.releaseSlug(job.slug, jobId);
    await store.updateJob(jobId, {
      status: "expired",
      updatedAt: now,
      errorCode: "INVITE_EXHAUSTED",
      errorMessage: "Invite code has no remaining uses.",
    });
    return errorResponse("INVITE_EXHAUSTED", "Invite code has no remaining uses.", 403);
  }

  try {
    await getBucket(env).put(job.uploadKey, limitStreamBytes(request.body, maxZipBytes(env), "ZIP_TOO_LARGE"), {
      httpMetadata: { contentType: "application/zip" },
    });
  } catch (error) {
    await store.decrementInviteUse(job.inviteCodeHash);
    if (isStreamLimitError(error, "ZIP_TOO_LARGE")) {
      await getBucket(env)
        .delete(job.uploadKey)
        .catch(() => {});
      return errorResponse("ZIP_TOO_LARGE", "ZIP is larger than the configured limit.", 413);
    }
    throw error;
  }
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
    try {
      await getBucket(env).delete(job.uploadKey);
      rawUploadDeletedAt = now;
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          message: "raw upload deletion failed",
          jobId: job.jobId,
          detail: String(error),
        })
      );
    }
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
    return this.db
      .prepare("SELECT code_hash AS codeHash, max_uses AS maxUses, uses FROM invites WHERE code_hash = ?")
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
      await this.db
        .prepare("INSERT INTO slugs (slug, job_id, created_at) VALUES (?, ?, ?)")
        .bind(slug, jobId, createdAt)
        .run();
      return true;
    } catch (error) {
      if (String(error).toLowerCase().includes("unique")) {
        return false;
      }
      throw error;
    }
  }

  async releaseSlug(slug, jobId) {
    await this.db.prepare("DELETE FROM slugs WHERE slug = ? AND job_id = ?").bind(slug, jobId).run();
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
    await this.db
      .prepare(`UPDATE jobs SET ${assignments} WHERE job_id = ?`)
      .bind(...values, jobId)
      .run();
  }

  async listReapableJobs(cutoffs) {
    const { reservedCutoff, queuedCutoff, processingCutoff } = cutoffs;
    const rows = await this.db
      .prepare(
        `SELECT
          job_id AS jobId, slug, display_name AS displayName, status,
          invite_code_hash AS inviteCodeHash, created_at AS createdAt, updated_at AS updatedAt,
          upload_key AS uploadKey, error_code AS errorCode, error_message AS errorMessage,
          site_url AS siteUrl, raw_upload_deleted_at AS rawUploadDeletedAt,
          start_date AS startDate, max_points AS maxPoints
        FROM jobs
        WHERE
          (status = 'reserved' AND updated_at < ?)
          OR (status = 'queued' AND updated_at < ?)
          OR (status = 'processing' AND updated_at < ?)
          OR (upload_key IS NOT NULL AND raw_upload_deleted_at IS NULL AND status IN ('ready', 'failed', 'expired'))
        ORDER BY updated_at ASC
        LIMIT 100`
      )
      .bind(reservedCutoff, queuedCutoff, processingCutoff)
      .all();
    return rows.results || [];
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
  return String(value || "")
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase();
}

function normalizeSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function isValidSlug(slug) {
  return /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(slug) && !RESERVED_SLUGS.has(slug);
}

function cleanDisplayName(value) {
  return String(value || "")
    .trim()
    .slice(0, 80);
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

function isValidJobId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function maxZipBytes(env) {
  const configured = Number(env.MAX_ZIP_BYTES || DEFAULT_MAX_ZIP_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_ZIP_BYTES;
}

function maxAssetBytes(assetName) {
  if (assetName === "points.bin") return 32 * 1024 * 1024;
  if (assetName === "meta.json") return 1024 * 1024;
  return 512 * 1024;
}

function inviteSecret(env) {
  return requiredSecret(env, "INVITE_HASH_SECRET", "local-invite-secret");
}

function uploadSecret(env) {
  return requiredSecret(env, "UPLOAD_TOKEN_SECRET", "local-upload-secret");
}

function requiredSecret(env, name, localFallback) {
  if (env[name]) {
    return env[name];
  }
  if (env.__TEST_STORE || env.__ALLOW_INSECURE_LOCAL_SECRETS) {
    return localFallback;
  }
  throw new Error(`${name} secret is required.`);
}

function limitStreamBytes(stream, maxBytes, errorCode) {
  let seen = 0;
  return stream.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        seen += chunkByteLength(chunk);
        if (seen > maxBytes) {
          controller.error(new Error(errorCode));
          return;
        }
        controller.enqueue(chunk);
      },
    })
  );
}

function chunkByteLength(chunk) {
  if (chunk instanceof Uint8Array) {
    return chunk.byteLength;
  }
  if (typeof chunk === "string") {
    return new TextEncoder().encode(chunk).byteLength;
  }
  if (chunk?.byteLength) {
    return Number(chunk.byteLength);
  }
  return 0;
}

function isStreamLimitError(error, code) {
  return error instanceof Error && error.message === code;
}

function siteUrlForSlug(slug, env) {
  if (env.PUBLIC_SITE_URL_PATTERN) {
    return String(env.PUBLIC_SITE_URL_PATTERN).replaceAll("{slug}", slug);
  }
  return `https://${slug}.${env.PUBLIC_HOST_SUFFIX || DEFAULT_PUBLIC_HOST_SUFFIX}`;
}

function slugFromHost(hostHeader, suffix = DEFAULT_PUBLIC_HOST_SUFFIX) {
  const host = hostHeader.split(":")[0].toLowerCase();
  const normalizedSuffix = String(suffix || DEFAULT_PUBLIC_HOST_SUFFIX).toLowerCase();
  if (!host.endsWith(`.${normalizedSuffix}`)) return null;
  const slug = host.slice(0, -normalizedSuffix.length - 1);
  if (slug.includes(".") || !isValidSlug(slug)) return null;
  return slug;
}

async function verifyTurnstile(request, env, token) {
  if (!env.TURNSTILE_SECRET_KEY) {
    return { ok: true };
  }
  if (env.__TEST_TURNSTILE_RESULT) {
    return env.__TEST_TURNSTILE_RESULT.ok
      ? { ok: true }
      : {
          ok: false,
          code: "TURNSTILE_FAILED",
          message: "Browser check failed.",
          status: 403,
        };
  }
  const responseToken = String(token || "").trim();
  if (!responseToken) {
    return {
      ok: false,
      code: "TURNSTILE_REQUIRED",
      message: "Browser check is required.",
      status: 400,
    };
  }
  const form = new FormData();
  form.set("secret", env.TURNSTILE_SECRET_KEY);
  form.set("response", responseToken);
  const remoteIp = request.headers.get("CF-Connecting-IP");
  if (remoteIp) {
    form.set("remoteip", remoteIp);
  }
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    return {
      ok: false,
      code: "TURNSTILE_UNAVAILABLE",
      message: "Browser check could not be verified.",
      status: 503,
    };
  }
  const result = await response.json().catch(() => ({}));
  if (!result.success) {
    return {
      ok: false,
      code: "TURNSTILE_FAILED",
      message: "Browser check failed.",
      status: 403,
    };
  }
  return { ok: true };
}

export async function reapStaleJobs(env, nowMs = Date.now()) {
  const now = new Date(nowMs).toISOString();
  const cutoffs = {
    reservedCutoff: new Date(nowMs - RESERVED_JOB_TTL_MS).toISOString(),
    queuedCutoff: new Date(nowMs - QUEUED_JOB_TTL_MS).toISOString(),
    processingCutoff: new Date(nowMs - PROCESSING_JOB_TTL_MS).toISOString(),
  };
  const store = getStore(env);
  const bucket = getBucket(env);
  const jobs = await store.listReapableJobs(cutoffs);
  const result = { checked: jobs.length, expired: 0, failed: 0, deletedUploads: 0, deletionFailures: 0 };

  for (const job of jobs) {
    let nextStatus = job.status;
    const patch = { updatedAt: now };
    if (job.status === "reserved" && job.updatedAt < cutoffs.reservedCutoff) {
      nextStatus = "expired";
      Object.assign(patch, {
        status: nextStatus,
        errorCode: "UPLOAD_SESSION_EXPIRED",
        errorMessage: "Upload session expired before a ZIP was received.",
      });
      await store.releaseSlug(job.slug, job.jobId);
      result.expired += 1;
    } else if (job.status === "queued" && job.updatedAt < cutoffs.queuedCutoff) {
      nextStatus = "failed";
      Object.assign(patch, {
        status: nextStatus,
        errorCode: "PROCESSOR_DISPATCH_TIMEOUT",
        errorMessage: "Processing did not start in time.",
      });
      result.failed += 1;
    } else if (job.status === "processing" && job.updatedAt < cutoffs.processingCutoff) {
      nextStatus = "failed";
      Object.assign(patch, {
        status: nextStatus,
        errorCode: "PROCESSOR_TIMEOUT",
        errorMessage: "Processing took too long and was stopped.",
      });
      result.failed += 1;
    }

    let rawUploadDeletedAt = job.rawUploadDeletedAt;
    if (job.uploadKey && !rawUploadDeletedAt && ["ready", "failed", "expired"].includes(nextStatus)) {
      try {
        await bucket.delete(job.uploadKey);
        rawUploadDeletedAt = now;
        patch.rawUploadDeletedAt = rawUploadDeletedAt;
        result.deletedUploads += 1;
      } catch (error) {
        result.deletionFailures += 1;
        console.error(
          JSON.stringify({
            level: "error",
            message: "reaper raw deletion failed",
            jobId: job.jobId,
            detail: String(error),
          })
        );
      }
    }

    if (Object.keys(patch).length > 1) {
      await store.updateJob(job.jobId, patch);
    }
  }

  return result;
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
  const length = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left[index] || 0) ^ (right[index] || 0);
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
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function jsonResponse(payload, status = 200) {
  const headers = securityHeaders();
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(payload), {
    status,
    headers,
  });
}

function htmlResponse(text, status = 200) {
  const headers = securityHeaders();
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(`<!doctype html><title>Garmin Footprints</title><p>${escapeHtml(text)}</p>`, {
    status,
    headers,
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

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of securityHeaders()) {
    if (!headers.has(key)) {
      headers.set(key, value);
    }
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
  const headers = securityHeaders();
  if (typeof object.writeHttpMetadata === "function") {
    object.writeHttpMetadata(headers);
  }
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", fallbackContentType);
  }
  return new Response(object.body, { headers });
}

function securityHeaders() {
  return new Headers({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src https://challenges.cloudflare.com; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
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
