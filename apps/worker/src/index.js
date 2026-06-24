const RESERVED_SLUGS = new Set([
  "www",
  "api",
  "admin",
  "administrator",
  "static",
  "asset",
  "assets",
  "cdn",
  "dashboard",
  "ftp",
  "help",
  "login",
  "logout",
  "mail",
  "root",
  "guide",
  "garmin",
  "connect",
  "processor",
  "runner-test",
  "signin",
  "signup",
  "status",
  "support",
  "test",
  "upload",
  "uploads",
  "jobs",
  "worker",
  "workers",
]);
const ALLOWED_ASSETS = new Set(["meta.json", "points.bin"]);
const LOCAL_MAX_ZIP_BYTES = 500 * 1024 * 1024;
const DEFAULT_START_DATE = "2022-05-01";
const DEFAULT_MAX_POINTS = 900_000;
const DEFAULT_PUBLIC_HOST_SUFFIX = "runmaps.larsheimann.com";
const RESERVED_JOB_TTL_MS = 60 * 60 * 1000;
const PUBLISHING_JOB_TTL_MS = 2 * 60 * 60 * 1000;
const MAP_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PUBLISH_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const SLUG_SUFFIX_LENGTH = 5;
const SLUG_RETRY_LIMIT = 12;
const SLUG_SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

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
    if (url.pathname.startsWith("/api/")) {
      return withCors(await handleApiRoute(request, env, ctx, url));
    }
    const deleteMatch = url.pathname.match(/^\/delete\/([^/]+)$/);
    if (deleteMatch) {
      return await handleDeletePage(request, env, deleteMatch[1]);
    }
    const publicMapMatch = publicMapPath(url.pathname);
    if (publicMapMatch) {
      return await serveGeneratedSite(request, env, publicMapMatch.slug, publicMapMatch.assetPath);
    }

    const siteSlug = slugFromHost(request.headers.get("Host") || url.host, env.PUBLIC_HOST_SUFFIX);
    if (siteSlug) {
      return await serveGeneratedSite(request, env, siteSlug);
    }
    if (hostLooksLikePublicSubdomain(request.headers.get("Host") || url.host, env.PUBLIC_HOST_SUFFIX)) {
      return new Response("Not found", { status: 404, headers: securityHeaders() });
    }

    if (env.ASSETS?.fetch) {
      if (url.pathname === "/guide/garmin-export") {
        return new Response("Not found", { status: 404, headers: securityHeaders() });
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
      maxZipBytes: LOCAL_MAX_ZIP_BYTES,
      localMaxZipBytes: LOCAL_MAX_ZIP_BYTES,
      publicHostSuffix: env.PUBLIC_HOST_SUFFIX || DEFAULT_PUBLIC_HOST_SUFFIX,
      maxMetaBytes: maxAssetBytes("meta.json"),
      maxPointsBytes: maxAssetBytes("points.bin"),
    });
  }

  if (request.method === "POST" && url.pathname === "/api/publish-sessions") {
    return createPublishSession(request, env);
  }

  const publishAssetMatch = url.pathname.match(/^\/api\/publish-sessions\/([^/]+)\/assets\/([^/]+)$/);
  if (request.method === "PUT" && publishAssetMatch) {
    return uploadPublishedAsset(request, env, publishAssetMatch[1], publishAssetMatch[2]);
  }

  const publishActionMatch = url.pathname.match(/^\/api\/publish-sessions\/([^/]+)\/(complete|abort)$/);
  if (request.method === "POST" && publishActionMatch) {
    return handlePublishAction(request, env, publishActionMatch[1], publishActionMatch[2]);
  }

  const deleteMatch = url.pathname.match(/^\/api\/delete\/([^/]+)$/);
  if (request.method === "POST" && deleteMatch) {
    return deleteByToken(env, deleteMatch[1]);
  }

  if (request.method === "POST" && url.pathname === "/api/maintenance/reap") {
    if (!(await isMaintenanceAuthorized(request, env))) {
      return errorResponse("UNAUTHORIZED", "Maintenance token is missing or invalid.", 401);
    }
    return jsonResponse(await reapStaleJobs(env));
  }

  const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (request.method === "GET" && jobMatch) {
    return getPublicJob(env, jobMatch[1]);
  }

  return errorResponse("NOT_FOUND", "Route not found.", 404);
}

async function createPublishSession(request, env) {
  const payload = await request.json().catch(() => null);
  if (!payload) {
    return errorResponse("INVALID_JSON", "Request body must be JSON.", 400);
  }

  const displayName = cleanDisplayName(payload.displayName);
  const slugBase = slugBaseFromDisplayName(displayName);
  if (!slugBase) {
    return errorResponse("INVALID_DISPLAY_NAME", "Display name must contain at least 2 letters or numbers.", 400);
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
  const inviteReserved = await store.reserveInviteUse(inviteHash);
  if (!inviteReserved) {
    return errorResponse("INVITE_EXHAUSTED", "Invite code has no remaining uses.", 403);
  }

  const slug = await reserveGeneratedSlug(store, slugBase, jobId, now);
  if (!slug) {
    await store.releaseInviteReservation(inviteHash);
    return errorResponse("SLUG_GENERATION_FAILED", "Could not reserve a public URL. Try publishing again.", 409);
  }

  const startDate = cleanStartDate(payload.startDate || env.DEFAULT_START_DATE || DEFAULT_START_DATE);
  const maxPoints = cleanMaxPoints(payload.maxPoints || env.DEFAULT_MAX_POINTS || DEFAULT_MAX_POINTS);
  const siteUrl = siteUrlForSlug(slug, env);
  const publishToken = await signUploadToken(env, {
    jobId,
    purpose: "publish",
    jti: crypto.randomUUID(),
    exp: Date.now() + PUBLISH_TOKEN_TTL_MS,
  });
  const deleteToken = `${crypto.randomUUID()}-${bytesToBase64url(crypto.getRandomValues(new Uint8Array(24)))}`;
  const deleteTokenHash = await hashSecretToken(deleteToken, uploadSecret(env));
  const publishExpiresAt = new Date(Date.now() + PUBLISH_TOKEN_TTL_MS).toISOString();
  const mapExpiresAt = new Date(Date.now() + MAP_TTL_MS).toISOString();

  try {
    await store.createJob({
      jobId,
      slug,
      displayName,
      status: "publishing",
      inviteCodeHash: inviteHash,
      createdAt: now,
      updatedAt: now,
      errorCode: null,
      errorMessage: null,
      siteUrl,
      rawUploadDeletedAt: null,
      uploadKey: null,
      startDate,
      maxPoints,
      uploadMode: "browser-artifacts",
      uploadId: null,
      uploadSize: null,
      uploadPartSize: null,
      uploadExpiresAt: publishExpiresAt,
      inviteUseState: "reserved",
      expiresAt: mapExpiresAt,
      publishedAt: null,
      deletedAt: null,
      deleteTokenHash,
    });
  } catch (error) {
    await store.releaseInviteReservation(inviteHash);
    await store.releaseSlug(slug, jobId);
    throw error;
  }

  return jsonResponse({
    jobId,
    slug,
    status: "publishing",
    publishToken,
    uploadMode: "browser-artifacts",
    maxMetaBytes: maxAssetBytes("meta.json"),
    maxPointsBytes: maxAssetBytes("points.bin"),
    expiresAt: publishExpiresAt,
    mapExpiresAt,
    siteUrl,
    deleteUrl: `${new URL(request.url).origin}/delete/${deleteToken}`,
    assetUrls: {
      "meta.json": `/api/publish-sessions/${jobId}/assets/meta.json`,
      "points.bin": `/api/publish-sessions/${jobId}/assets/points.bin`,
    },
  });
}

async function uploadPublishedAsset(request, env, jobId, assetName) {
  if (!isValidJobId(jobId)) {
    return errorResponse("INVALID_JOB_ID", "Job ID is invalid.", 400);
  }
  if (!ALLOWED_ASSETS.has(assetName)) {
    return errorResponse("INVALID_ASSET", "Asset name is not allowed.", 400);
  }
  const token = bearerToken(request);
  if (!token) {
    return errorResponse("MISSING_PUBLISH_TOKEN", "Publish token is required.", 401);
  }
  const tokenPayload = await verifyUploadToken(env, token);
  if (!tokenPayload || tokenPayload.jobId !== jobId || tokenPayload.purpose !== "publish") {
    return errorResponse("INVALID_PUBLISH_TOKEN", "Publish token is invalid or expired.", 401);
  }

  const store = getStore(env);
  const job = await store.getJob(jobId);
  if (!job) {
    return errorResponse("JOB_NOT_FOUND", "Job was not found.", 404);
  }
  if (job.status !== "publishing") {
    return errorResponse("INVALID_STATUS", "Job is not waiting for generated map files.", 409);
  }
  if (job.uploadExpiresAt && Date.parse(job.uploadExpiresAt) < Date.now()) {
    await expirePublishReservation(env, job, "PUBLISH_SESSION_EXPIRED", "Publish session expired.");
    return errorResponse("INVALID_PUBLISH_TOKEN", "This publish session expired. Publish again.", 401);
  }
  const contentLength = Number(request.headers.get("Content-Length") || "");
  if (!Number.isFinite(contentLength) || contentLength <= 0) {
    return errorResponse("LENGTH_REQUIRED", "Content-Length is required.", 411);
  }
  if (contentLength > maxAssetBytes(assetName)) {
    return errorResponse("ASSET_TOO_LARGE", "Generated map file is larger than allowed.", 413);
  }
  if (!request.body) {
    return errorResponse("EMPTY_UPLOAD", "Generated map file body is required.", 400);
  }
  try {
    await getBucket(env).put(
      `sites/${job.slug}/${assetName}`,
      limitStreamBytes(request.body, maxAssetBytes(assetName), "ASSET_TOO_LARGE"),
      { httpMetadata: { contentType: contentTypeForPath(assetName) } }
    );
  } catch (error) {
    if (isStreamLimitError(error, "ASSET_TOO_LARGE")) {
      await getBucket(env)
        .delete(`sites/${job.slug}/${assetName}`)
        .catch(() => {});
      return errorResponse("ASSET_TOO_LARGE", "Generated map file is larger than allowed.", 413);
    }
    throw error;
  }
  return jsonResponse({ ok: true, jobId: job.jobId, assetName });
}

async function handlePublishAction(request, env, jobId, action) {
  if (!isValidJobId(jobId)) {
    return errorResponse("INVALID_JOB_ID", "Job ID is invalid.", 400);
  }
  const token = bearerToken(request);
  if (!token) {
    return errorResponse("MISSING_PUBLISH_TOKEN", "Publish token is required.", 401);
  }
  const tokenPayload = await verifyUploadToken(env, token);
  if (!tokenPayload || tokenPayload.jobId !== jobId || tokenPayload.purpose !== "publish") {
    return errorResponse("INVALID_PUBLISH_TOKEN", "Publish token is invalid or expired.", 401);
  }
  const job = await getStore(env).getJob(jobId);
  if (!job) {
    return errorResponse("JOB_NOT_FOUND", "Job was not found.", 404);
  }
  if (action === "abort") {
    await expirePublishReservation(env, job, "PUBLISH_ABORTED", "Publish was canceled.");
    return jsonResponse({ jobId: job.jobId, status: "expired" });
  }
  return completePublish(env, job);
}

async function completePublish(env, job) {
  if (job.status !== "publishing") {
    if (job.status === "ready") {
      return jsonResponse({ jobId: job.jobId, status: "ready", siteUrl: job.siteUrl });
    }
    return errorResponse("INVALID_STATUS", "Job is not waiting for generated map files.", 409);
  }
  const validation = await validatePublishedAssets(env, job);
  if (validation.error) {
    await expirePublishReservation(env, job, validation.error.code, validation.error.message);
    await deleteSiteAssets(env, job.slug);
    return errorResponse(validation.error.code, validation.error.message, validation.error.status || 400);
  }
  const consumed = await getStore(env).consumeInviteReservation(job.inviteCodeHash);
  if (!consumed) {
    await expirePublishReservation(env, job, "INVITE_EXHAUSTED", "Invite code has no remaining uses.");
    await deleteSiteAssets(env, job.slug);
    return errorResponse("INVITE_EXHAUSTED", "Invite code has no remaining uses.", 403);
  }
  const now = new Date().toISOString();
  await getStore(env).updateJob(job.jobId, {
    status: "ready",
    updatedAt: now,
    publishedAt: now,
    errorCode: null,
    errorMessage: null,
    inviteUseState: "consumed",
    siteUrl: job.siteUrl || siteUrlForSlug(job.slug, env),
  });
  return jsonResponse({
    jobId: job.jobId,
    slug: job.slug,
    status: "ready",
    siteUrl: job.siteUrl || siteUrlForSlug(job.slug, env),
    expiresAt: job.expiresAt,
  });
}

async function expirePublishReservation(env, job, errorCode, errorMessage) {
  const now = new Date().toISOString();
  const store = getStore(env);
  if (job.inviteUseState === "reserved") {
    await store.releaseInviteReservation(job.inviteCodeHash);
  }
  await store.releaseSlug(job.slug, job.jobId);
  await store.updateJob(job.jobId, {
    status: "expired",
    updatedAt: now,
    errorCode,
    errorMessage,
    inviteUseState: "released",
  });
}

async function validatePublishedAssets(env, job) {
  const bucket = getBucket(env);
  const [metaObject, pointsObject] = await Promise.all([
    bucket.get(`sites/${job.slug}/meta.json`),
    bucket.get(`sites/${job.slug}/points.bin`),
  ]);
  if (!metaObject || !pointsObject) {
    return { error: { code: "PUBLISH_ASSETS_MISSING", message: "Generated map files were missing." } };
  }
  const [metaBuffer, pointsBuffer] = await Promise.all([metaObject.arrayBuffer(), pointsObject.arrayBuffer()]);
  if (metaBuffer.byteLength > maxAssetBytes("meta.json") || pointsBuffer.byteLength > maxAssetBytes("points.bin")) {
    return { error: { code: "ASSET_TOO_LARGE", message: "Generated map files are larger than allowed.", status: 413 } };
  }
  let meta;
  try {
    meta = JSON.parse(new TextDecoder().decode(metaBuffer));
  } catch {
    return { error: { code: "INVALID_META", message: "Generated metadata is not valid JSON." } };
  }
  const pointCount = Number(meta.pointCount);
  if (!Number.isInteger(pointCount) || pointCount <= 0 || pointCount > 3_000_000) {
    return { error: { code: "INVALID_META", message: "Generated metadata has an invalid point count." } };
  }
  if (pointsBuffer.byteLength !== pointCount * 12) {
    return { error: { code: "POINTS_SIZE_MISMATCH", message: "Generated points file does not match metadata." } };
  }
  const rewrittenMeta = {
    ...meta,
    slug: job.slug,
    displayName: job.displayName,
    viewerTitle: possessiveTitle(job.displayName),
    siteUrl: job.siteUrl,
    localOnly: false,
    publishedAt: new Date().toISOString(),
    expiresAt: job.expiresAt,
    privacy: {
      ...(typeof meta.privacy === "object" && meta.privacy ? meta.privacy : {}),
      rawZipUploaded: false,
      browserProcessed: true,
    },
  };
  await bucket.put(`sites/${job.slug}/meta.json`, JSON.stringify(rewrittenMeta), {
    httpMetadata: { contentType: contentTypeForPath("meta.json") },
  });
  return { meta: rewrittenMeta };
}

async function deleteSiteAssets(env, slug) {
  await getBucket(env)
    .delete([`sites/${slug}/meta.json`, `sites/${slug}/points.bin`])
    .catch(() => {});
}

async function handleDeletePage(request, env, token) {
  const tokenHash = await hashSecretToken(token, uploadSecret(env));
  const job = await getStore(env).getJobByDeleteTokenHash(tokenHash);
  if (!job) {
    return htmlResponse("This delete link is invalid or expired.", 404);
  }
  const deleted = job.status === "deleted" || Boolean(job.deletedAt);
  const expires = job.expiresAt ? new Date(job.expiresAt).toLocaleDateString("en-US") : "30 days after publishing";
  const title = deleted ? "This map was already deleted." : `Delete ${job.displayName || "this map"}?`;
  const body = deleted
    ? `<p>This public running map has already been deleted.</p><p><a href="/">Create a new map</a></p>`
    : `<p>The public URL <code>${escapeHtml(job.siteUrl || siteUrlForSlug(job.slug, env))}</code> will stop working immediately.</p>
       <p>If you do nothing, this map will be automatically deleted on ${escapeHtml(expires)}.</p>
       <form method="post" action="/api/delete/${encodeURIComponent(token)}">
         <button type="submit">Delete map now</button>
       </form>
       <p><a href="${escapeHtml(job.siteUrl || siteUrlForSlug(job.slug, env))}">Keep it and view the map</a></p>`;
  return fullHtmlResponse(title, body);
}

async function deleteByToken(env, token) {
  const tokenHash = await hashSecretToken(token, uploadSecret(env));
  const job = await getStore(env).getJobByDeleteTokenHash(tokenHash);
  if (!job) {
    return errorResponse("DELETE_TOKEN_INVALID", "Delete link is invalid or expired.", 404);
  }
  if (job.status !== "deleted") {
    const now = new Date().toISOString();
    await deleteSiteAssets(env, job.slug);
    await getStore(env).updateJob(job.jobId, { status: "deleted", deletedAt: now, updatedAt: now });
  }
  return fullHtmlResponse("Map deleted", `<p>This map has been deleted.</p><p><a href="/">Create a new map</a></p>`);
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
    expiresAt: job.expiresAt,
    publishedAt: job.publishedAt,
    deletedAt: job.deletedAt,
  });
}

async function serveGeneratedSite(request, env, slug, assetPath = null) {
  const url = new URL(request.url);
  const path = assetPath || (url.pathname === "/" ? "index.html" : url.pathname.slice(1));
  const job = await getStore(env).getJobBySlug(slug);
  if (!job) {
    return new Response("Not found", { status: 404 });
  }
  if (["deleted", "expired"].includes(job.status) || (job.expiresAt && Date.parse(job.expiresAt) <= Date.now())) {
    return expiredMapResponse();
  }
  if (job.status !== "ready") {
    return new Response("Not found", { status: 404 });
  }
  if (path === "index.html" || path === "app.js" || path === "styles.css") {
    if (!env.ASSETS?.fetch) return new Response("Not found", { status: 404 });
    const assetUrl = new URL(request.url);
    assetUrl.hostname = url.hostname;
    assetUrl.pathname = `/viewer/${path}`;
    const response = await env.ASSETS.fetch(new Request(assetUrl.toString(), request));
    const secured = withSecurityHeaders(response);
    secured.headers.set("Cache-Control", path === "index.html" ? "public, max-age=60" : "public, max-age=3600");
    return secured;
  }
  if (!ALLOWED_ASSETS.has(path)) {
    return new Response("Not found", { status: 404 });
  }
  const object = await getBucket(env).get(`sites/${slug}/${path}`);
  if (!object) {
    return new Response("Not found", { status: 404 });
  }
  const response = objectResponse(object, contentTypeForPath(path));
  response.headers.set("Cache-Control", "public, max-age=31536000");
  return response;
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
      .prepare(
        "SELECT code_hash AS codeHash, label, max_uses AS maxUses, uses, reserved_uses AS reservedUses FROM invites WHERE code_hash = ?"
      )
      .bind(hash)
      .first();
  }

  async reserveInviteUse(hash) {
    const result = await this.db
      .prepare(
        "UPDATE invites SET reserved_uses = reserved_uses + 1 WHERE code_hash = ? AND uses + reserved_uses < max_uses"
      )
      .bind(hash)
      .run();
    return Number(result.meta?.changes || 0) === 1;
  }

  async consumeInviteReservation(hash) {
    const result = await this.db
      .prepare(
        "UPDATE invites SET reserved_uses = MAX(reserved_uses - 1, 0), uses = uses + 1 WHERE code_hash = ? AND reserved_uses > 0 AND uses < max_uses"
      )
      .bind(hash)
      .run();
    return Number(result.meta?.changes || 0) === 1;
  }

  async releaseInviteReservation(hash) {
    await this.db
      .prepare("UPDATE invites SET reserved_uses = MAX(reserved_uses - 1, 0) WHERE code_hash = ?")
      .bind(hash)
      .run();
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
          upload_key, error_code, error_message, site_url, raw_upload_deleted_at, start_date, max_points,
          upload_mode, upload_id, upload_size, upload_part_size, upload_expires_at, invite_use_state,
          expires_at, published_at, deleted_at, delete_token_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        job.maxPoints,
        job.uploadMode,
        job.uploadId,
        job.uploadSize,
        job.uploadPartSize,
        job.uploadExpiresAt,
        job.inviteUseState,
        job.expiresAt,
        job.publishedAt,
        job.deletedAt,
        job.deleteTokenHash
      )
      .run();
  }

  jobSelectSql(whereClause) {
    return `SELECT
      job_id AS jobId, slug, display_name AS displayName, status,
      invite_code_hash AS inviteCodeHash, created_at AS createdAt, updated_at AS updatedAt,
      upload_key AS uploadKey, error_code AS errorCode, error_message AS errorMessage,
      site_url AS siteUrl, raw_upload_deleted_at AS rawUploadDeletedAt,
      start_date AS startDate, max_points AS maxPoints,
      upload_mode AS uploadMode, upload_id AS uploadId, upload_size AS uploadSize,
      upload_part_size AS uploadPartSize, upload_expires_at AS uploadExpiresAt,
      invite_use_state AS inviteUseState, expires_at AS expiresAt,
      published_at AS publishedAt, deleted_at AS deletedAt,
      delete_token_hash AS deleteTokenHash
    FROM jobs ${whereClause}`;
  }

  async getJob(jobId) {
    const row = await this.db.prepare(this.jobSelectSql("WHERE job_id = ?")).bind(jobId).first();
    return row || null;
  }

  async getJobBySlug(slug) {
    const row = await this.db
      .prepare(this.jobSelectSql("WHERE slug = ? ORDER BY created_at DESC LIMIT 1"))
      .bind(slug)
      .first();
    return row || null;
  }

  async getJobByDeleteTokenHash(hash) {
    const row = await this.db.prepare(this.jobSelectSql("WHERE delete_token_hash = ? LIMIT 1")).bind(hash).first();
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
      uploadMode: "upload_mode",
      uploadId: "upload_id",
      uploadSize: "upload_size",
      uploadPartSize: "upload_part_size",
      uploadExpiresAt: "upload_expires_at",
      inviteUseState: "invite_use_state",
      expiresAt: "expires_at",
      publishedAt: "published_at",
      deletedAt: "deleted_at",
      deleteTokenHash: "delete_token_hash",
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
    const { reservedCutoff, publishingCutoff, now } = cutoffs;
    const rows = await this.db
      .prepare(
        `${this.jobSelectSql("")}
        WHERE
          (status = 'reserved' AND updated_at < ?)
          OR (status = 'publishing' AND updated_at < ?)
          OR (status = 'ready' AND expires_at IS NOT NULL AND expires_at <= ?)
        ORDER BY updated_at ASC
        LIMIT 100`
      )
      .bind(reservedCutoff, publishingCutoff, now)
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

function isValidSlug(slug) {
  return /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(slug) && !RESERVED_SLUGS.has(slug);
}

function cleanDisplayName(value) {
  return String(value || "")
    .trim()
    .slice(0, 80);
}

function slugBaseFromDisplayName(value) {
  const normalized = String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const trimmed = normalized.slice(0, 34).replace(/-$/g, "");
  return trimmed.length >= 2 ? trimmed : "";
}

async function reserveGeneratedSlug(store, slugBase, jobId, createdAt) {
  for (let attempt = 0; attempt < SLUG_RETRY_LIMIT; attempt += 1) {
    const slug = `${slugBase}-${randomSlugSuffix()}`;
    if (!isValidSlug(slug)) continue;
    if (await store.reserveSlug(slug, jobId, createdAt)) return slug;
  }
  return null;
}

function randomSlugSuffix() {
  const bytes = crypto.getRandomValues(new Uint8Array(SLUG_SUFFIX_LENGTH));
  return Array.from(bytes, (byte) => SLUG_SUFFIX_ALPHABET[byte % SLUG_SUFFIX_ALPHABET.length]).join("");
}

function possessiveTitle(displayName) {
  const name = cleanDisplayName(displayName);
  if (!name) return "Running Footprints";
  return `${name}${name.toLowerCase().endsWith("s") ? "'" : "'s"} Running Footprints`;
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

function bearerToken(request) {
  return (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
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
  return `https://${env.PUBLIC_HOST_SUFFIX || DEFAULT_PUBLIC_HOST_SUFFIX}/m/${slug}`;
}

function publicMapPath(pathname) {
  const match = pathname.match(/^\/m\/([^/]+)(?:\/(.*))?$/);
  if (!match || !isValidSlug(match[1])) return null;
  const assetPath = match[2] || "index.html";
  if (assetPath === "") return { slug: match[1], assetPath: "index.html" };
  return { slug: match[1], assetPath };
}

function slugFromHost(hostHeader, suffix = DEFAULT_PUBLIC_HOST_SUFFIX) {
  const host = hostHeader.split(":")[0].toLowerCase();
  const normalizedSuffix = String(suffix || DEFAULT_PUBLIC_HOST_SUFFIX).toLowerCase();
  if (!host.endsWith(`.${normalizedSuffix}`)) return null;
  const slug = host.slice(0, -normalizedSuffix.length - 1);
  if (slug.includes(".") || !isValidSlug(slug)) return null;
  return slug;
}

function hostLooksLikePublicSubdomain(hostHeader, suffix = DEFAULT_PUBLIC_HOST_SUFFIX) {
  const host = hostHeader.split(":")[0].toLowerCase();
  const normalizedSuffix = String(suffix || DEFAULT_PUBLIC_HOST_SUFFIX).toLowerCase();
  const prefix = host.slice(0, -normalizedSuffix.length - 1);
  return host.endsWith(`.${normalizedSuffix}`) && Boolean(prefix) && !prefix.includes(".");
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
    now,
    reservedCutoff: new Date(nowMs - RESERVED_JOB_TTL_MS).toISOString(),
    publishingCutoff: new Date(nowMs - PUBLISHING_JOB_TTL_MS).toISOString(),
  };
  const store = getStore(env);
  const jobs = await store.listReapableJobs(cutoffs);
  const result = { checked: jobs.length, expired: 0, deletedMaps: 0, deletionFailures: 0 };

  for (const job of jobs) {
    const patch = { updatedAt: now };
    if (job.status === "reserved" && job.updatedAt < cutoffs.reservedCutoff) {
      Object.assign(patch, {
        status: "expired",
        errorCode: "PUBLISH_SESSION_EXPIRED",
        errorMessage: "Publish session expired before generated files were received.",
      });
      await store.releaseSlug(job.slug, job.jobId);
      result.expired += 1;
    } else if (job.status === "publishing" && job.updatedAt < cutoffs.publishingCutoff) {
      if (job.inviteUseState === "reserved") {
        await store.releaseInviteReservation(job.inviteCodeHash);
        patch.inviteUseState = "released";
      }
      await store.releaseSlug(job.slug, job.jobId);
      await deleteSiteAssets(env, job.slug);
      Object.assign(patch, {
        status: "expired",
        errorCode: "PUBLISH_SESSION_EXPIRED",
        errorMessage: "Publish session expired before generated files were received.",
      });
      result.expired += 1;
    } else if (job.status === "ready" && job.expiresAt && job.expiresAt <= now) {
      try {
        await deleteSiteAssets(env, job.slug);
        Object.assign(patch, {
          status: "expired",
          errorCode: "MAP_EXPIRED",
          errorMessage: "Map expired after 30 days.",
        });
        result.expired += 1;
        result.deletedMaps += 1;
      } catch (error) {
        result.deletionFailures += 1;
        console.error(
          JSON.stringify({
            level: "error",
            message: "reaper map deletion failed",
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

async function hashSecretToken(token, secret) {
  return bytesToBase64url(await hmacBytes(secret, String(token || "")));
}

async function isMaintenanceAuthorized(request, env) {
  const expected = env.MAINTENANCE_TOKEN || env.PROCESSOR_TOKEN;
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

function fullHtmlResponse(title, body, status = 200) {
  const headers = securityHeaders();
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(
    `<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>${escapeHtml(title)}</title>
          <style>
            body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #101716; color: #f4f7f4; }
            main { max-width: 42rem; padding: 2rem; }
            a { color: #7dd3c7; }
            button { background: #c2410c; color: white; border: 0; border-radius: .4rem; padding: .75rem 1rem; font: inherit; cursor: pointer; }
            code { word-break: break-all; }
          </style>
        </head>
        <body><main><h1>${escapeHtml(title)}</h1>${body}</main></body>
      </html>`,
    { status, headers }
  );
}

function expiredMapResponse() {
  return fullHtmlResponse(
    "This running map is no longer available",
    `<p>Shared Runmaps are public for 30 days and can also be deleted earlier by their creator.</p>
     <p>This link has expired or was deleted. You can create a new running map from a Garmin export.</p>
     <p><a href="https://runmaps.larsheimann.com/">Create a new map</a></p>`,
    410
  );
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
      "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self' https://challenges.cloudflare.com; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'",
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
