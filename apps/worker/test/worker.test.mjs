import test from "node:test";
import assert from "node:assert/strict";
import worker, { hashInviteCode } from "../src/index.js";
import { MemoryBucket, MemoryStore } from "../src/testing.js";

const INVITE_SECRET = "test-invite-secret";
const UPLOAD_SECRET = "test-upload-secret";
const PROCESSOR_TOKEN = "processor-token";

async function makeEnv(invites = [["ALPHA-1", 1]]) {
  const store = new MemoryStore();
  for (const [code, maxUses] of invites) {
    store.addInvite(await hashInviteCode(code, INVITE_SECRET), maxUses);
  }
  return {
    __TEST_STORE: store,
    __TEST_BUCKET: new MemoryBucket(),
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

test("rejects invalid invites and reserved slugs", async () => {
  const env = await makeEnv();

  const badInvite = await worker.fetch(
    new Request("https://runs.example.com/api/upload-sessions", {
      method: "POST",
      body: JSON.stringify({ inviteCode: "wrong", slug: "runner" }),
    }),
    env,
    waitContext().ctx
  );
  assert.equal(badInvite.status, 403);

  const reservedSlug = await worker.fetch(
    new Request("https://runs.example.com/api/upload-sessions", {
      method: "POST",
      body: JSON.stringify({ inviteCode: "ALPHA-1", slug: "admin" }),
    }),
    env,
    waitContext().ctx
  );
  assert.equal(reservedSlug.status, 400);
});

test("reserves slugs uniquely and enforces invite use limits", async () => {
  const env = await makeEnv([
    ["ALPHA-1", 1],
    ["BETA-2", 2],
  ]);

  const first = await worker.fetch(
    new Request("https://runs.example.com/api/upload-sessions", {
      method: "POST",
      body: JSON.stringify({ inviteCode: "ALPHA-1", slug: "runner" }),
    }),
    env,
    waitContext().ctx
  );
  assert.equal(first.status, 200);

  const exhausted = await worker.fetch(
    new Request("https://runs.example.com/api/upload-sessions", {
      method: "POST",
      body: JSON.stringify({ inviteCode: "ALPHA-1", slug: "runner-two" }),
    }),
    env,
    waitContext().ctx
  );
  assert.equal(exhausted.status, 403);

  const duplicate = await worker.fetch(
    new Request("https://runs.example.com/api/upload-sessions", {
      method: "POST",
      body: JSON.stringify({ inviteCode: "BETA-2", slug: "runner" }),
    }),
    env,
    waitContext().ctx
  );
  assert.equal(duplicate.status, 409);
});

test("streams uploads, rejects oversized ZIPs, and exposes queued job status", async () => {
  const env = await makeEnv();
  const { ctx, pending } = waitContext();
  const sessionResponse = await worker.fetch(
    new Request("https://runs.example.com/api/upload-sessions", {
      method: "POST",
      body: JSON.stringify({ inviteCode: "ALPHA-1", slug: "runner", displayName: "Runner" }),
    }),
    env,
    ctx
  );
  const session = await json(sessionResponse);

  const tooLarge = await worker.fetch(
    new Request(session.uploadUrl, {
      method: "PUT",
      headers: { "Content-Length": "33" },
      body: "x".repeat(33),
    }),
    env,
    ctx
  );
  assert.equal(tooLarge.status, 413);

  const upload = await worker.fetch(
    new Request(session.uploadUrl, {
      method: "PUT",
      headers: { "Content-Length": "8", "Content-Type": "application/zip" },
      body: "zip-data",
    }),
    env,
    ctx
  );
  assert.equal(upload.status, 200);
  await Promise.all(pending);

  const status = await worker.fetch(new Request(`https://runs.example.com/api/jobs/${session.jobId}`), env, ctx);
  const job = await json(status);
  assert.equal(job.status, "queued");
  assert.equal(env.__TEST_BUCKET.has(`uploads/${session.jobId}/garmin-export.zip`), true);
});

test("processor success stores assets, serves wildcard site, and deletes raw upload", async () => {
  const env = await makeEnv();
  const { ctx } = waitContext();
  const session = await json(
    await worker.fetch(
      new Request("https://runs.example.com/api/upload-sessions", {
        method: "POST",
        body: JSON.stringify({ inviteCode: "ALPHA-1", slug: "runner", displayName: "Runner" }),
      }),
      env,
      ctx
    )
  );

  await worker.fetch(
    new Request(session.uploadUrl, {
      method: "PUT",
      headers: { "Content-Length": "8" },
      body: "zip-data",
    }),
    env,
    ctx
  );

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
        headers: auth,
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
});

test("processor failure deletes raw upload and records clear status", async () => {
  const env = await makeEnv();
  const { ctx } = waitContext();
  const session = await json(
    await worker.fetch(
      new Request("https://runs.example.com/api/upload-sessions", {
        method: "POST",
        body: JSON.stringify({ inviteCode: "ALPHA-1", slug: "runner" }),
      }),
      env,
      ctx
    )
  );
  await worker.fetch(
    new Request(session.uploadUrl, {
      method: "PUT",
      headers: { "Content-Length": "8" },
      body: "zip-data",
    }),
    env,
    ctx
  );

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

  const status = await json(await worker.fetch(new Request(`https://runs.example.com/api/jobs/${session.jobId}`), env, ctx));
  assert.equal(status.status, "failed");
  assert.equal(status.errorCode, "NO_RUNS_FOUND");
  assert.ok(status.rawUploadDeletedAt);
});
