import test from "node:test";
import assert from "node:assert/strict";
import worker, { hashInviteCode, reapStaleJobs } from "../src/index.js";
import { MemoryBucket, MemoryStore } from "../src/testing.js";

const INVITE_SECRET = "test-invite-secret";
const UPLOAD_SECRET = "test-upload-secret";
const MAINTENANCE_TOKEN = "maintenance-token";

/**
 * @param {Array<[string, number, string]>} invites
 */
async function makeEnv(invites = [["ALPHA-1", 2, "Alpha group"]]) {
  const store = new MemoryStore();
  for (const [code, maxUses, label] of invites) {
    store.addInvite(await hashInviteCode(code, INVITE_SECRET), maxUses, label);
  }
  return {
    __TEST_STORE: store,
    __TEST_BUCKET: new MemoryBucket(),
    INVITE_HASH_SECRET: INVITE_SECRET,
    UPLOAD_TOKEN_SECRET: UPLOAD_SECRET,
    MAINTENANCE_TOKEN,
    PUBLIC_HOST_SUFFIX: "runs.example.com",
    PUBLIC_SITE_URL_PATTERN: "https://{slug}.runs.example.com",
    DEFAULT_MAX_POINTS: "250000",
  };
}

function waitContext() {
  return { waitUntil() {} };
}

async function json(response) {
  return response.json();
}

function publishPayload(overrides = {}) {
  return { inviteCode: "ALPHA-1", displayName: "Lárs Heimann!", ...overrides };
}

async function createPublishSession(env, ctx, overrides = {}) {
  return worker.fetch(
    new Request("https://runs.example.com/api/publish-sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(publishPayload(overrides)),
    }),
    env,
    ctx
  );
}

function validMeta(pointCount = 2) {
  return JSON.stringify({
    generatedAt: "2026-06-24T00:00:00.000Z",
    slug: "local-preview",
    displayName: "Local",
    viewerTitle: "Local's Running Footprints",
    pointCount,
    parsedRunActivities: 1,
    start: "2024-01-01T00:00:00.000Z",
    end: "2024-01-02T00:00:00.000Z",
    localOnly: true,
  });
}

function validPoints(pointCount = 2) {
  return Buffer.alloc(pointCount * 12);
}

async function uploadAsset(env, ctx, session, name, body, type = "application/octet-stream") {
  return worker.fetch(
    new Request(`https://runs.example.com${session.assetUrls[name]}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${session.publishToken}`,
        "Content-Type": type,
        "Content-Length": String(Buffer.byteLength(body)),
      },
      body,
    }),
    env,
    ctx
  );
}

async function publishReady(env, ctx, overrides = {}) {
  const session = await json(await createPublishSession(env, ctx, overrides));
  assert.match(session.slug, /^[a-z0-9-]+-[a-z0-9]{5}$/);
  assert.match(session.deleteUrl, /^https:\/\/runs\.example\.com\/delete\//);
  assert.equal((await uploadAsset(env, ctx, session, "meta.json", validMeta(), "application/json")).status, 200);
  assert.equal((await uploadAsset(env, ctx, session, "points.bin", validPoints())).status, 200);
  const complete = await worker.fetch(
    new Request(`https://runs.example.com/api/publish-sessions/${session.jobId}/complete`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.publishToken}`, "Content-Type": "application/json" },
      body: "{}",
    }),
    env,
    ctx
  );
  assert.equal(complete.status, 200);
  return { session, complete: await json(complete) };
}

test("exposes browser-first public configuration", async () => {
  const env = await makeEnv();
  env.TURNSTILE_SITE_KEY = "site-key";
  const response = await worker.fetch(new Request("https://runs.example.com/api/config"), env, waitContext());
  assert.equal(response.status, 200);
  const config = await json(response);
  assert.equal(config.turnstileSiteKey, "site-key");
  assert.equal(config.localMaxZipBytes, 500 * 1024 * 1024);
  assert.equal(config.maxZipBytes, 500 * 1024 * 1024);
  assert.equal(config.publicHostSuffix, "runs.example.com");
});

test("rejects invalid invites and invalid display names", async () => {
  const env = await makeEnv();
  const badInvite = await createPublishSession(env, waitContext(), { inviteCode: "wrong" });
  assert.equal(badInvite.status, 403);

  const badName = await createPublishSession(env, waitContext(), { displayName: "!" });
  assert.equal(badName.status, 400);
});

test("requires Turnstile when configured", async () => {
  const env = await makeEnv();
  env.TURNSTILE_SECRET_KEY = "turnstile-secret";

  const missing = await createPublishSession(env, waitContext());
  assert.equal(missing.status, 400);

  env.__TEST_TURNSTILE_RESULT = { ok: false };
  const failed = await createPublishSession(env, waitContext(), { turnstileToken: "bad-token" });
  assert.equal(failed.status, 403);

  env.__TEST_TURNSTILE_RESULT = { ok: true };
  const passed = await createPublishSession(env, waitContext(), { turnstileToken: "ok-token" });
  assert.equal(passed.status, 200);
});

test("publishes only derived assets and consumes invite on completion", async () => {
  const env = await makeEnv([["ALPHA-1", 1, "Alpha group"]]);
  const alphaHash = await hashInviteCode("ALPHA-1", INVITE_SECRET);
  const { session, complete } = await publishReady(env, waitContext());
  assert.equal(complete.status, "ready");
  assert.equal(env.__TEST_STORE.invites.get(alphaHash).reservedUses, 0);
  assert.equal(env.__TEST_STORE.invites.get(alphaHash).uses, 1);

  const job = env.__TEST_STORE.jobs.get(session.jobId);
  assert.equal(job.status, "ready");
  assert.ok(job.expiresAt);
  assert.ok(job.publishedAt);
  assert.equal(env.__TEST_BUCKET.has(`sites/${session.slug}/meta.json`), true);
  assert.equal(env.__TEST_BUCKET.has(`sites/${session.slug}/points.bin`), true);
  assert.equal(env.__TEST_BUCKET.has(`uploads/${session.jobId}/garmin-export.zip`), false);
});

test("normalizes display names and retries generated slug collisions", async () => {
  const env = await makeEnv([["ALPHA-1", 2, "Alpha group"]]);
  let attempts = 0;
  const originalReserveSlug = env.__TEST_STORE.reserveSlug.bind(env.__TEST_STORE);
  env.__TEST_STORE.reserveSlug = async (slug, jobId, createdAt) => {
    attempts += 1;
    if (attempts === 1) return false;
    return originalReserveSlug(slug, jobId, createdAt);
  };

  const { session } = await publishReady(env, waitContext(), { displayName: "Lárs Heimann" });
  assert.match(session.slug, /^lars-heimann-[a-z0-9]{5}$/);
  assert.ok(attempts >= 2);

  const meta = JSON.parse(await env.__TEST_BUCKET.text(`sites/${session.slug}/meta.json`));
  assert.equal(meta.viewerTitle, "Lárs Heimann's Running Footprints");
});

test("serves shared viewer and data for a published map", async () => {
  const env = await makeEnv();
  env.ASSETS = {
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      return new Response(`asset:${path}`, {
        headers: { "Content-Type": path.endsWith(".css") ? "text/css" : "text/html" },
      });
    },
  };
  const { session } = await publishReady(env, waitContext());

  const index = await worker.fetch(
    new Request(`https://${session.slug}.runs.example.com/`, { headers: { Host: `${session.slug}.runs.example.com` } }),
    env,
    waitContext()
  );
  assert.equal(index.status, 200);
  assert.match(await index.text(), /asset:\/viewer\/index\.html/);

  const meta = await worker.fetch(
    new Request(`https://${session.slug}.runs.example.com/meta.json`, {
      headers: { Host: `${session.slug}.runs.example.com` },
    }),
    env,
    waitContext()
  );
  assert.equal(meta.status, 200);
  const metaPayload = await json(meta);
  assert.equal(metaPayload.slug, session.slug);
  assert.equal(metaPayload.localOnly, false);
  assert.equal(metaPayload.privacy.rawZipUploaded, false);
});

test("reserved wildcard hosts do not serve the upload app", async () => {
  const env = await makeEnv();
  env.ASSETS = { fetch: async () => new Response("upload app") };
  const response = await worker.fetch(
    new Request("https://admin.runs.example.com/", { headers: { Host: "admin.runs.example.com" } }),
    env,
    waitContext()
  );
  assert.equal(response.status, 404);
});

test("rejects malformed generated assets and releases invite reservation", async () => {
  const env = await makeEnv([["ALPHA-1", 1, "Alpha group"]]);
  const alphaHash = await hashInviteCode("ALPHA-1", INVITE_SECRET);
  const session = await json(await createPublishSession(env, waitContext()));
  assert.equal(
    (await uploadAsset(env, waitContext(), session, "meta.json", validMeta(3), "application/json")).status,
    200
  );
  assert.equal((await uploadAsset(env, waitContext(), session, "points.bin", validPoints(2))).status, 200);
  const complete = await worker.fetch(
    new Request(`https://runs.example.com/api/publish-sessions/${session.jobId}/complete`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.publishToken}`, "Content-Type": "application/json" },
      body: "{}",
    }),
    env,
    waitContext()
  );
  assert.equal(complete.status, 400);
  assert.equal(env.__TEST_STORE.invites.get(alphaHash).reservedUses, 0);
  assert.equal(env.__TEST_STORE.invites.get(alphaHash).uses, 0);
});

test("delete link opens confirmation and POST deletion is idempotent", async () => {
  const env = await makeEnv();
  const { session } = await publishReady(env, waitContext());
  const token = new URL(session.deleteUrl).pathname.split("/").pop();

  const page = await worker.fetch(new Request(session.deleteUrl), env, waitContext());
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Delete/);
  assert.equal(env.__TEST_STORE.jobs.get(session.jobId).status, "ready");

  const deleted = await worker.fetch(
    new Request(`https://runs.example.com/api/delete/${token}`, { method: "POST" }),
    env,
    waitContext()
  );
  assert.equal(deleted.status, 200);
  assert.equal(env.__TEST_STORE.jobs.get(session.jobId).status, "deleted");
  assert.equal(env.__TEST_BUCKET.has(`sites/${session.slug}/meta.json`), false);

  const again = await worker.fetch(
    new Request(`https://runs.example.com/api/delete/${token}`, { method: "POST" }),
    env,
    waitContext()
  );
  assert.equal(again.status, 200);
});

test("reaper expires stale publishing jobs and 30-day maps", async () => {
  const env = await makeEnv([["ALPHA-1", 2, "Alpha group"]]);
  const alphaHash = await hashInviteCode("ALPHA-1", INVITE_SECRET);
  const staleSession = await json(await createPublishSession(env, waitContext()));
  await env.__TEST_STORE.updateJob(staleSession.jobId, {
    updatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
  });
  const staleResult = await reapStaleJobs(env, Date.now());
  assert.equal(staleResult.expired, 1);
  assert.equal(env.__TEST_STORE.invites.get(alphaHash).reservedUses, 0);

  const { session } = await publishReady(env, waitContext(), { displayName: "Second Runner" });
  await env.__TEST_STORE.updateJob(session.jobId, { expiresAt: new Date(Date.now() - 1000).toISOString() });
  const expiryResult = await reapStaleJobs(env, Date.now());
  assert.equal(expiryResult.expired, 1);
  assert.equal(env.__TEST_STORE.jobs.get(session.jobId).status, "expired");
  assert.equal(env.__TEST_BUCKET.has(`sites/${session.slug}/meta.json`), false);
});

test("raw ZIP upload and processor callback routes are unavailable", async () => {
  const env = await makeEnv();
  const upload = await worker.fetch(
    new Request("https://runs.example.com/api/upload-sessions", { method: "POST" }),
    env,
    waitContext()
  );
  assert.equal(upload.status, 404);
  const processor = await worker.fetch(
    new Request("https://runs.example.com/api/processor/reap", { method: "POST" }),
    env,
    waitContext()
  );
  assert.equal(processor.status, 404);
});

test("Garmin guide route returns 404", async () => {
  const env = await makeEnv();
  env.ASSETS = { fetch: async () => new Response("asset") };
  const response = await worker.fetch(new Request("https://runs.example.com/guide/garmin-export"), env, waitContext());
  assert.equal(response.status, 404);
});
