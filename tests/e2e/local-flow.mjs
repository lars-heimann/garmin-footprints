import { createServer } from "node:http";
import { readFile, stat, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, extname } from "node:path";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import worker, { hashInviteCode, reapStaleJobs } from "../../apps/worker/src/index.js";
import { MemoryBucket, MemoryStore } from "../../apps/worker/src/testing.js";
import { buildVisualizationFromGarminFile } from "../../apps/web/browser-processing/processor-core.js";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const INVITE_SECRET = "e2e-invite-secret";
const UPLOAD_SECRET = "e2e-upload-secret";
const MAINTENANCE_TOKEN = "e2e-maintenance-token";

function contentType(path) {
  const ext = extname(path);
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function staticAssets(directory) {
  return {
    async fetch(request) {
      const url = new URL(request.url);
      const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
      const target = resolve(directory, `.${pathname}`);
      if (!target.startsWith(resolve(directory))) {
        return new Response("Not found", { status: 404 });
      }
      try {
        const info = await stat(target);
        if (!info.isFile()) throw new Error("not a file");
        return new Response(await readFile(target), {
          headers: { "Content-Type": contentType(target) },
        });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    },
  };
}

async function startServer(env) {
  const pending = [];
  const server = createServer(async (incoming, outgoing) => {
    try {
      const effectiveHost = String(incoming.headers["x-test-host"] || incoming.headers.host || "127.0.0.1");
      const url = `http://${effectiveHost}${incoming.url}`;
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) {
          for (const item of value) headers.append(key, item);
        } else if (value !== undefined) {
          headers.set(key, value);
        }
      }
      headers.set("Host", effectiveHost);
      const hasBody = incoming.method !== "GET" && incoming.method !== "HEAD";
      const request = new Request(
        url,
        /** @type {RequestInit & { duplex?: "half" }} */ ({
          method: incoming.method,
          headers,
          body: hasBody ? /** @type {any} */ (incoming) : undefined,
          duplex: hasBody ? "half" : undefined,
        })
      );
      const response = await worker.fetch(request, env, {
        waitUntil(promise) {
          pending.push(promise);
        },
      });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        Readable.fromWeb(/** @type {any} */ (response.body)).pipe(outgoing);
      } else {
        outgoing.end();
      }
    } catch (error) {
      outgoing.writeHead(500, { "Content-Type": "text/plain" });
      outgoing.end(String(error?.stack || error));
    }
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen(undefined)));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Local e2e server did not expose a TCP port.");
  }
  const { port } = address;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    async close() {
      await Promise.allSettled(pending);
      await new Promise((resolveClose) => server.close(resolveClose));
    },
  };
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const { timeoutMs = 30000, allowTimeoutFile = null, ...spawnOptions } = options;
    const child = spawn(command, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], ...spawnOptions });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(async () => {
      child.kill("SIGKILL");
      if (allowTimeoutFile) {
        try {
          const info = await stat(allowTimeoutFile);
          if (info.size > 1000) {
            finish(resolveRun, { stdout, stderr, timedOutAfterOutput: true });
            return;
          }
        } catch {
          // Fall through to the timeout error.
        }
      }
      finish(
        rejectRun,
        new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`)
      );
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish(rejectRun, error);
    });
    child.on("close", (code) => {
      if (settled) return;
      if (code === 0) {
        finish(resolveRun, { stdout, stderr });
      } else {
        finish(
          rejectRun,
          new Error(`${command} ${args.join(" ")} exited ${code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`)
        );
      }
    });
  });
}

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function chromeSmoke(basePort, workDir, slug, viewport) {
  const chrome = chromePath();
  if (!chrome) {
    throw new Error("Chrome was not found for browser smoke tests. Set CHROME_PATH.");
  }
  const screenshot = join(workDir, `site-${viewport.width}x${viewport.height}.png`);
  await run(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-extensions",
      "--no-first-run",
      "--no-default-browser-check",
      "--timeout=10000",
      `--user-data-dir=${join(workDir, `chrome-${viewport.width}`)}`,
      `--window-size=${viewport.width},${viewport.height}`,
      "--virtual-time-budget=3000",
      `--screenshot=${screenshot}`,
      `http://127.0.0.1:${basePort}/m/${slug}/`,
    ],
    { timeoutMs: 15000, allowTimeoutFile: screenshot }
  );
  const info = await stat(screenshot);
  assert.ok(info.size > 1000, `expected non-empty screenshot for ${viewport.width}x${viewport.height}`);
}

async function createLocalPreview(exportZip, displayName) {
  const zipBytes = await readFile(exportZip);
  const file = new File([zipBytes], "garmin-export.zip", { type: "application/zip" });
  return buildVisualizationFromGarminFile(file, {
    displayName,
    slug: "local-preview",
    startDate: "2022-05-01",
    maxPoints: 10000,
  });
}

async function assertOk(response) {
  if (!response.ok) {
    assert.fail(`expected ${response.url} to succeed, got ${response.status}: ${await response.text()}`);
  }
}

async function publishPreview(server, displayName, preview) {
  const sessionResponse = await fetch(`${server.url}/api/publish-sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      inviteCode: "E2E-CODE",
      displayName,
    }),
  });
  await assertOk(sessionResponse);
  const session = await sessionResponse.json();
  assert.match(session.slug, /^[a-z0-9-]+-[a-z0-9]{5}$/);
  assert.match(session.deleteUrl, /\/delete\//);

  const metaResponse = await fetch(`${server.url}${session.assetUrls["meta.json"]}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${session.publishToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(preview.meta),
  });
  await assertOk(metaResponse);

  const pointsBytes = new Uint8Array(preview.points.buffer, preview.points.byteOffset, preview.points.byteLength);
  const pointsResponse = await fetch(`${server.url}${session.assetUrls["points.bin"]}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${session.publishToken}`,
      "Content-Type": "application/octet-stream",
    },
    body: pointsBytes,
  });
  await assertOk(pointsResponse);

  const completeResponse = await fetch(`${server.url}/api/publish-sessions/${session.jobId}/complete`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.publishToken}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  await assertOk(completeResponse);
  const complete = await completeResponse.json();
  assert.equal(complete.status, "ready");
  return { session, complete };
}

async function main() {
  const workDir = await mkdtemp(join(tmpdir(), "garmin-footprints-e2e-"));
  const store = new MemoryStore();
  store.addInvite(await hashInviteCode("E2E-CODE", INVITE_SECRET), 5, "E2E group");
  const bucket = new MemoryBucket();
  const env = {
    __TEST_STORE: store,
    __TEST_BUCKET: bucket,
    ASSETS: staticAssets(join(ROOT, "apps/web")),
    INVITE_HASH_SECRET: INVITE_SECRET,
    UPLOAD_TOKEN_SECRET: UPLOAD_SECRET,
    MAINTENANCE_TOKEN,
    PUBLIC_HOST_SUFFIX: "runs.example.com",
    PUBLIC_SITE_URL_PATTERN: "https://runs.example.com/m/{slug}",
    DEFAULT_MAX_POINTS: "10000",
  };

  const server = await startServer(env);
  try {
    const appResponse = await fetch(`${server.url}/`);
    assert.equal(appResponse.status, 200);
    const appHtml = await appResponse.text();
    assert.match(appHtml, /Your Garmin ZIP never leaves your browser/);
    assert.match(appHtml, /Open Garmin export page/);

    const guideResponse = await fetch(`${server.url}/guide/garmin-export`);
    assert.equal(guideResponse.status, 404);

    const oldUploadResponse = await fetch(`${server.url}/api/upload-sessions`, { method: "POST" });
    assert.equal(oldUploadResponse.status, 404);

    const exportZip = join(workDir, "garmin.zip");
    await run("python3", ["processor/tests/fixtures.py", exportZip]);
    const preview = await createLocalPreview(exportZip, "E2E Runner");
    assert.equal(preview.meta.slug, "local-preview");
    assert.equal(preview.meta.displayName, "E2E Runner");
    assert.equal(preview.meta.privacy.rawZipUploaded, undefined);

    const { session, complete } = await publishPreview(server, "E2E Runner", preview);
    assert.equal(complete.siteUrl, `https://runs.example.com/m/${session.slug}`);

    const siteResponse = await fetch(`${server.url}/m/${session.slug}/`);
    assert.equal(siteResponse.status, 200);
    assert.match(await siteResponse.text(), /Running Footprints/);

    const meta = await (await fetch(`${server.url}/m/${session.slug}/meta.json`)).json();
    const points = await (await fetch(`${server.url}/m/${session.slug}/points.bin`)).arrayBuffer();
    assert.equal(points.byteLength, meta.pointCount * 12);
    assert.equal(meta.displayName, "E2E Runner");
    assert.equal(meta.slug, session.slug);
    assert.equal(meta.localOnly, false);
    assert.equal(meta.privacy.rawZipUploaded, false);
    assert.equal(meta.privacy.browserProcessed, true);
    assert.ok(meta.expiresAt);

    await chromeSmoke(server.port, workDir, session.slug, { width: 1440, height: 900 });
    await chromeSmoke(server.port, workDir, session.slug, { width: 390, height: 844 });

    const deletePage = await fetch(session.deleteUrl.replace("https://runs.example.com", server.url));
    assert.equal(deletePage.status, 200);
    assert.match(await deletePage.text(), /Delete E2E Runner/);

    const deletePath = new URL(session.deleteUrl).pathname;
    const deleteResponse = await fetch(`${server.url}/api${deletePath}`, {
      method: "POST",
    });
    assert.equal(deleteResponse.status, 200);
    assert.equal(bucket.has(`sites/${session.slug}/meta.json`), false);
    const deletedSite = await fetch(`${server.url}/m/${session.slug}/`);
    assert.equal(deletedSite.status, 410);

    const secondPreview = await createLocalPreview(exportZip, "Expiry Runner");
    const { session: expirySession } = await publishPreview(server, "Expiry Runner", secondPreview);
    const expiryJob = store.jobs.get(expirySession.jobId);
    expiryJob.expiresAt = new Date(Date.now() - 60_000).toISOString();
    await reapStaleJobs(env, Date.now());
    assert.equal(bucket.has(`sites/${expirySession.slug}/meta.json`), false);
    const expiredSite = await fetch(`${server.url}/m/${expirySession.slug}/`);
    assert.equal(expiredSite.status, 410);
  } finally {
    await server.close();
    await rm(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
