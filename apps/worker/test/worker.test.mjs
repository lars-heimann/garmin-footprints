import test from "node:test";
import assert from "node:assert/strict";
import worker, { hashInviteCode, reapStaleJobs } from "../src/index.js";
import { MemoryBucket, MemoryStore } from "../src/testing.js";

const INVITE_SECRET = "test-invite-secret";
const UPLOAD_SECRET = "test-upload-secret";
const PROCESSOR_TOKEN = "processor-token";
const ZIP_TEXT = "zip-data";
const ZIP_SIZE = Buffer.byteLength(ZIP_TEXT);

/**
 * @param {Array<[string, number]>} invites
 */
async function makeEnv(invites = [["ALPHA-1", 1]]) {
  const store = new MemoryStore();
  for (const [code, maxUses] of invites) {
    store.addInvite(await hashInviteCode(code, INVITE_SECRET), maxUses);
  }
  return {
    __TEST_STORE: store,
    __TEST_BUCKET: new MemoryBucket(),
    __TEST_R2_UPLOAD_BASE: "https://r2.example.com",
    INVITE_HASH_SECRET: INVITE_SECRET,
    UPLOAD_TOKEN_SECRET: UPLOAD_SECRET,
    PROCESSOR_TOKEN,
    PUBLIC_HOST_SUFFIX: "runs.example.com",
    MAX_ZIP_BYTES: "32",
    DEFAULT_MAX_POINTS: "250000",
  };
}

function waitContext() {
  const pending = [];
  return {
    pending,
    ctx: {
      waitUntil(promise) {
        pending.push(promise);
      },
    },
  };
}

async function json(response) {
  return response.json();
}

function sessionPayload(overrides = {}) {
  return {
    inviteCode: "ALPHA-1",
    slug: "runner",
    fileSize: ZIP_SIZE,
    ...overrides,
  };
}

async function createSession(env, ctx, overrides = {}) {
  return worker.fetch(
    new Request("https://runs.example.com/api/upload-sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sessionPayload(overrides)),
    }),
    env,
    ctx
  );
}

async function uploadPartToMemoryBucket(env, session, partNumber = 1, body = ZIP_TEXT) {
  const job = env.__TEST_STORE.jobs.get(session.jobId);
  const upload = env.__TEST_BUCKET.resumeMultipartUpload(job.uploadKey, job.uploadId);
  return upload.uploadPart(partNumber, body);
}

async function completeTestUpload(env, ctx, session, body = ZIP_TEXT) {
  const part = await uploadPartToMemoryBucket(env, session, 1, body);
  return worker.fetch(
    new Request(`https://runs.example.com/api/uploads/${session.jobId}/complete`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.uploadToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ size: Buffer.byteLength(body), parts: [part] }),
    }),
    env,
    ctx
  );
}

test("exposes public upload configuration", async () => {
  const env = await makeEnv();
  env.TURNSTILE_SITE_KEY = "site-key";
  const response = await worker.fetch(new Request("https://runs.example.com/api/config"), env, waitContext().ctx);
  assert.equal(response.status, 200);
  const config = await json(response);
  assert.equal(config.turnstileSiteKey, "site-key");
  assert.equal(config.maxZipBytes, 32);
  assert.equal(config.publicHostSuffix, "runs.example.com");
});

test("rejects invalid invites and reserved slugs", async () => {
  const env = await makeEnv();

  const badInvite = await createSession(env, waitContext().ctx, { inviteCode: "wrong" });
  assert.equal(badInvite.status, 403);

  const reservedSlug = await createSession(env, waitContext().ctx, { slug: "admin" });
  assert.equal(reservedSlug.status, 400);
});

test("requires Turnstile when configured", async () => {
  const env = await makeEnv();
  env.TURNSTILE_SECRET_KEY = "turnstile-secret";

  const missing = await createSession(env, waitContext().ctx);
  assert.equal(missing.status, 400);

  env.__TEST_TURNSTILE_RESULT = { ok: false };
  const failed = await createSession(env, waitContext().ctx, { turnstileToken: "bad-token" });
  assert.equal(failed.status, 403);

  env.__TEST_TURNSTILE_RESULT = { ok: true };
  const passed = await createSession(env, waitContext().ctx, { turnstileToken: "ok-token" });
  assert.equal(passed.status, 200);
});

test("reserves slugs and invite capacity until multipart completion consumes the invite", async () => {
  const env = await makeEnv([
    ["ALPHA-1", 1],
    ["BETA-2", 2],
  ]);
  const alphaHash = await hashInviteCode("ALPHA-1", INVITE_SECRET);
  const { ctx, pending } = waitContext();

  const first = await createSession(env, ctx, { displayName: "Runner" });
  assert.equal(first.status, 200);
  const firstSession = await json(first);
  assert.equal(env.__TEST_STORE.invites.get(alphaHash).reservedUses, 1);
  assert.equal(env.__TEST_STORE.invites.get(alphaHash).uses, 0);

  const exhaustedWhileReserved = await createSession(env, ctx, { slug: "runner-two" });
  assert.equal(exhaustedWhileReserved.status, 403);

  const duplicateSlug = await createSession(env, ctx, { inviteCode: "BETA-2", slug: "runner" });
  assert.equal(duplicateSlug.status, 409);

  const completed = await completeTestUpload(env, ctx, firstSession);
  assert.equal(completed.status, 200);
  await Promise.all(pending);
  assert.equal(env.__TEST_STORE.invites.get(alphaHash).reservedUses, 0);
  assert.equal(env.__TEST_STORE.invites.get(alphaHash).uses, 1);

  const exhaustedAfterCompletion = await createSession(env, ctx, { slug: "runner-three" });
  assert.equal(exhaustedAfterCompletion.status, 403);
});

test("creates multipart sessions, signs part URLs, completes uploads, and exposes queued status", async () => {
  const env = await makeEnv();
  const { ctx, pending } = waitContext();
  const sessionResponse = await createSession(env, ctx, { displayName: "Runner" });
  assert.equal(sessionResponse.status, 200);
  const session = await json(sessionResponse);
  assert.equal(session.uploadMode, "r2-multipart");
  assert.equal(session.partSizeBytes, 16 * 1024 * 1024);
  assert.equal(session.maxZipBytes, 32);
  assert.ok(session.uploadToken);
  assert.ok(session.expiresAt);
  assert.equal(session.siteUrl, "https://runner.runs.example.com");

  const signed = await worker.fetch(
    new Request(`https://runs.example.com/api/uploads/${session.jobId}/parts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.uploadToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ partNumbers: [1] }),
    }),
    env,
    ctx
  );
  assert.equal(signed.status, 200);
  const signedPayload = await json(signed);
  assert.equal(signedPayload.urls[0].partNumber, 1);
  assert.match(signedPayload.urls[0].url, /^https:\/\/r2\.example\.com\/__r2\//);

  const completed = await completeTestUpload(env, ctx, session);
  assert.equal(completed.status, 200);
  assert.equal(env.__TEST_BUCKET.has(`uploads/${session.jobId}/garmin-export.zip`), true);
  await Promise.all(pending);

  const status = await worker.fetch(new Request(`https://runs.example.com/api/jobs/${session.jobId}`), env, ctx);
  const job = await json(status);
  assert.equal(job.status, "queued");

  const replay = await worker.fetch(
    new Request(`https://runs.example.com/api/uploads/${session.jobId}/complete`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.uploadToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        size: ZIP_SIZE,
        parts: [{ partNumber: 1, etag: `"${String(1).padStart(32, "0")}"` }],
      }),
    }),
    env,
    ctx
  );
  assert.equal(replay.status, 200);
  assert.equal((await json(replay)).status, "queued");
});

test("rejects sessions that omit file size or exceed the configured ZIP limit", async () => {
  const env = await makeEnv();
  const alphaHash = await hashInviteCode("ALPHA-1", INVITE_SECRET);
  const { ctx } = waitContext();

  const missingSize = await worker.fetch(
    new Request("https://runs.example.com/api/upload-sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inviteCode: "ALPHA-1", slug: "runner" }),
    }),
    env,
    ctx
  );
  assert.equal(missingSize.status, 400);

  const tooLarge = await createSession(env, ctx, { fileSize: 33 });
  assert.equal(tooLarge.status, 413);
  assert.equal(env.__TEST_STORE.invites.get(alphaHash).reservedUses, 0);
  assert.equal(env.__TEST_STORE.invites.get(alphaHash).uses, 0);
});

test("rejects invalid part URL requests", async () => {
  const env = await makeEnv();
  const { ctx } = waitContext();
  const session = await json(await createSession(env, ctx));

  const missingToken = await worker.fetch(
    new Request(`https://runs.example.com/api/uploads/${session.jobId}/parts`, {
      method: "POST",
      body: JSON.stringify({ partNumbers: [1] }),
    }),
    env,
    ctx
  );
  assert.equal(missingToken.status, 401);

  for (const partNumbers of [[0], [2], [1, 1], [1, 2, 3, 4, 5, 6, 7, 8, 9]]) {
    const response = await worker.fetch(
      new Request(`https://runs.example.com/api/uploads/${session.jobId}/parts`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.uploadToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ partNumbers }),
      }),
      env,
      ctx
    );
    assert.equal(response.status, 400);
  }
});

test("rejects malformed multipart completion payloads", async () => {
  const env = await makeEnv([["ALPHA-1", 4]]);
  const alphaHash = await hashInviteCode("ALPHA-1", INVITE_SECRET);
  const { ctx } = waitContext();

  const buildInvalidBody = [
    (part) => ({ size: ZIP_SIZE + 1, parts: [part] }),
    () => ({ size: ZIP_SIZE, parts: [] }),
    (part) => ({ size: ZIP_SIZE, parts: [{ partNumber: 2, etag: part.etag }] }),
    () => ({ size: ZIP_SIZE, parts: [{ partNumber: 1, etag: "not-an-etag" }] }),
  ];

  for (const [index, buildBody] of buildInvalidBody.entries()) {
    const session = await json(await createSession(env, ctx, { slug: `runner-${index + 1}` }));
    const part = await uploadPartToMemoryBucket(env, session);
    const body = buildBody(part);
    const response = await worker.fetch(
      new Request(`https://runs.example.com/api/uploads/${session.jobId}/complete`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.uploadToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
      ctx
    );
    assert.equal(response.status, 400);
    assert.equal(env.__TEST_STORE.invites.get(alphaHash).reservedUses, 0);
    assert.equal(env.__TEST_STORE.slugs.has(`runner-${index + 1}`), false);
  }
});

test("abort releases invite reservation and slug", async () => {
  const env = await makeEnv();
  const alphaHash = await hashInviteCode("ALPHA-1", INVITE_SECRET);
  const { ctx } = waitContext();
  const session = await json(await createSession(env, ctx));

  const abort = await worker.fetch(
    new Request(`https://runs.example.com/api/uploads/${session.jobId}/abort`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.uploadToken}` },
    }),
    env,
    ctx
  );
  assert.equal(abort.status, 200);
  assert.equal(env.__TEST_STORE.invites.get(alphaHash).reservedUses, 0);
  assert.equal(env.__TEST_STORE.slugs.has("runner"), false);

  const retry = await createSession(env, ctx);
  assert.equal(retry.status, 200);
});

test("processor success stores assets, serves wildcard site, and deletes raw upload", async () => {
  const env = await makeEnv();
  const { ctx } = waitContext();
  const session = await json(await createSession(env, ctx, { displayName: "Runner" }));
  await completeTestUpload(env, ctx, session);

  const auth = { Authorization: `Bearer ${PROCESSOR_TOKEN}` };
  const start = await worker.fetch(
    new Request(`https://runs.example.com/api/processor/jobs/${session.jobId}/start`, {
      method: "POST",
      headers: auth,
      body: "{}",
    }),
    env,
    ctx
  );
  assert.equal(start.status, 200);

  for (const [name, body] of [
    ["index.html", "<!doctype html><title>Runner</title>"],
    ["app.js", "console.log('ok')"],
    ["styles.css", "body{}"],
    ["meta.json", '{"pointCount":1}'],
    ["points.bin", "\0".repeat(12)],
  ]) {
    const response = await worker.fetch(
      new Request(`https://runs.example.com/api/processor/jobs/${session.jobId}/assets/${name}`, {
        method: "PUT",
        headers: { ...auth, "Content-Length": String(Buffer.byteLength(body)) },
        body,
      }),
      env,
      ctx
    );
    assert.equal(response.status, 200);
  }

  const complete = await worker.fetch(
    new Request(`https://runs.example.com/api/processor/jobs/${session.jobId}/complete`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ready" }),
    }),
    env,
    ctx
  );
  assert.equal(complete.status, 200);
  assert.equal(env.__TEST_BUCKET.has(`uploads/${session.jobId}/garmin-export.zip`), false);

  const site = await worker.fetch(
    new Request("https://runner.runs.example.com/", {
      headers: { Host: "runner.runs.example.com" },
    }),
    env,
    ctx
  );
  assert.equal(site.status, 200);
  assert.match(await site.text(), /Runner/);

  const rawUpload = await worker.fetch(
    new Request(`https://runner.runs.example.com/uploads/${session.jobId}/garmin-export.zip`, {
      headers: { Host: "runner.runs.example.com" },
    }),
    env,
    ctx
  );
  assert.equal(rawUpload.status, 404);
});

test("rejects forged processor callbacks and unauthorized asset names", async () => {
  const env = await makeEnv();
  const { ctx } = waitContext();
  const session = await json(await createSession(env, ctx));

  const forged = await worker.fetch(
    new Request(`https://runs.example.com/api/processor/jobs/${session.jobId}/complete`, {
      method: "POST",
      body: JSON.stringify({ status: "ready" }),
    }),
    env,
    ctx
  );
  assert.equal(forged.status, 401);

  await completeTestUpload(env, ctx, session);
  const auth = { Authorization: `Bearer ${PROCESSOR_TOKEN}` };
  await worker.fetch(
    new Request(`https://runs.example.com/api/processor/jobs/${session.jobId}/start`, {
      method: "POST",
      headers: auth,
      body: "{}",
    }),
    env,
    ctx
  );
  const invalidAsset = await worker.fetch(
    new Request(`https://runs.example.com/api/processor/jobs/${session.jobId}/assets/garmin-export.zip`, {
      method: "PUT",
      headers: { ...auth, "Content-Length": "8" },
      body: "zip-data",
    }),
    env,
    ctx
  );
  assert.equal(invalidAsset.status, 400);
});

test("processor failure deletes raw upload and records clear status", async () => {
  const env = await makeEnv();
  const { ctx } = waitContext();
  const session = await json(await createSession(env, ctx));
  await completeTestUpload(env, ctx, session);

  const auth = { Authorization: `Bearer ${PROCESSOR_TOKEN}`, "Content-Type": "application/json" };
  await worker.fetch(
    new Request(`https://runs.example.com/api/processor/jobs/${session.jobId}/start`, {
      method: "POST",
      headers: auth,
      body: "{}",
    }),
    env,
    ctx
  );
  const failed = await worker.fetch(
    new Request(`https://runs.example.com/api/processor/jobs/${session.jobId}/complete`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ status: "failed", errorCode: "NO_RUNS_FOUND", errorMessage: "No runs." }),
    }),
    env,
    ctx
  );
  assert.equal(failed.status, 200);
  assert.equal(env.__TEST_BUCKET.has(`uploads/${session.jobId}/garmin-export.zip`), false);

  const status = await json(
    await worker.fetch(new Request(`https://runs.example.com/api/jobs/${session.jobId}`), env, ctx)
  );
  assert.equal(status.status, "failed");
  assert.equal(status.errorCode, "NO_RUNS_FOUND");
  assert.ok(status.rawUploadDeletedAt);
});

test("reaper expires stale jobs and retries raw ZIP deletion", async () => {
  const env = await makeEnv();
  const { ctx } = waitContext();
  const session = await json(await createSession(env, ctx));
  await completeTestUpload(env, ctx, session);

  const stale = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  await env.__TEST_STORE.updateJob(session.jobId, { status: "processing", updatedAt: stale });
  const result = await reapStaleJobs(env, Date.now());
  assert.equal(result.failed, 1);
  assert.equal(result.deletedUploads, 1);

  const status = await json(
    await worker.fetch(new Request(`https://runs.example.com/api/jobs/${session.jobId}`), env, ctx)
  );
  assert.equal(status.status, "failed");
  assert.equal(status.errorCode, "PROCESSOR_TIMEOUT");
  assert.ok(status.rawUploadDeletedAt);
  assert.equal(env.__TEST_BUCKET.has(`uploads/${session.jobId}/garmin-export.zip`), false);
});

test("reaper aborts stale multipart uploads and releases slugs and invites", async () => {
  const env = await makeEnv();
  const alphaHash = await hashInviteCode("ALPHA-1", INVITE_SECRET);
  const { ctx } = waitContext();
  const session = await json(await createSession(env, ctx));

  const stale = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
  await env.__TEST_STORE.updateJob(session.jobId, { updatedAt: stale });
  const result = await reapStaleJobs(env, Date.now());

  assert.equal(result.expired, 1);
  assert.equal(env.__TEST_STORE.invites.get(alphaHash).reservedUses, 0);
  assert.equal(env.__TEST_STORE.slugs.has("runner"), false);
  const retry = await createSession(env, ctx);
  assert.equal(retry.status, 200);
});
