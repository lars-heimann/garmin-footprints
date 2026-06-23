import { createServer } from "node:http";
import { readFile, stat, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, extname } from "node:path";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import worker, { hashInviteCode } from "../../apps/worker/src/index.js";
import { MemoryBucket, MemoryStore } from "../../apps/worker/src/testing.js";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const INVITE_SECRET = "e2e-invite-secret";
const UPLOAD_SECRET = "e2e-upload-secret";
const PROCESSOR_TOKEN = "e2e-processor-token";

function contentType(path) {
  const ext = extname(path);
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
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

async function chromeSmoke(basePort, workDir, viewport) {
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
      `--host-resolver-rules=MAP runner.runs.example.com 127.0.0.1`,
      `--window-size=${viewport.width},${viewport.height}`,
      "--virtual-time-budget=3000",
      `--screenshot=${screenshot}`,
      `http://runner.runs.example.com:${basePort}/`,
    ],
    { timeoutMs: 15000, allowTimeoutFile: screenshot }
  );
  const info = await stat(screenshot);
  assert.ok(info.size > 1000, `expected non-empty screenshot for ${viewport.width}x${viewport.height}`);
}

async function main() {
  const workDir = await mkdtemp(join(tmpdir(), "garmin-footprints-e2e-"));
  const store = new MemoryStore();
  store.addInvite(await hashInviteCode("E2E-CODE", INVITE_SECRET), 1);
  const bucket = new MemoryBucket();
  const env = {
    __TEST_STORE: store,
    __TEST_BUCKET: bucket,
    ASSETS: staticAssets(join(ROOT, "apps/web")),
    INVITE_HASH_SECRET: INVITE_SECRET,
    UPLOAD_TOKEN_SECRET: UPLOAD_SECRET,
    PROCESSOR_TOKEN,
    PUBLIC_HOST_SUFFIX: "runs.example.com",
    MAX_ZIP_BYTES: String(8 * 1024 * 1024),
    DEFAULT_MAX_POINTS: "10000",
  };

  const server = await startServer(env);
  try {
    const appResponse = await fetch(`${server.url}/`);
    assert.equal(appResponse.status, 200);
    assert.match(await appResponse.text(), /Garmin ZIP/);

    const exportZip = join(workDir, "garmin.zip");
    await run("python3", ["processor/tests/fixtures.py", exportZip]);

    const sessionResponse = await fetch(`${server.url}/api/upload-sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inviteCode: "E2E-CODE", slug: "runner", displayName: "E2E Runner" }),
    });
    assert.equal(sessionResponse.status, 200);
    const session = await sessionResponse.json();

    const zipBytes = await readFile(exportZip);
    const uploadResponse = await fetch(session.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/zip", "Content-Length": String(zipBytes.length) },
      body: zipBytes,
    });
    assert.equal(uploadResponse.status, 200);

    const queued = await (await fetch(`${server.url}/api/jobs/${session.jobId}`)).json();
    assert.equal(queued.status, "queued");

    await run("python3", [
      "processor/process_job.py",
      "--job-id",
      session.jobId,
      "--api-base",
      server.url,
      "--processor-token",
      PROCESSOR_TOKEN,
      "--template-dir",
      join(ROOT, "template"),
      "--work-dir",
      workDir,
    ]);

    const ready = await (await fetch(`${server.url}/api/jobs/${session.jobId}`)).json();
    assert.equal(ready.status, "ready");
    assert.equal(ready.siteUrl, "https://runner.runs.example.com");
    assert.ok(ready.rawUploadDeletedAt);
    assert.equal(bucket.has(`uploads/${session.jobId}/garmin-export.zip`), false);

    const hostHeaders = { "X-Test-Host": "runner.runs.example.com" };
    const siteResponse = await fetch(`${server.url}/`, { headers: hostHeaders });
    assert.equal(siteResponse.status, 200);
    assert.match(await siteResponse.text(), /Running Footprints/);

    const meta = await (await fetch(`${server.url}/meta.json`, { headers: hostHeaders })).json();
    const points = await (await fetch(`${server.url}/points.bin`, { headers: hostHeaders })).arrayBuffer();
    assert.equal(points.byteLength, meta.pointCount * 12);
    assert.equal(meta.displayName, "E2E Runner");
    assert.ok(meta.pointCount > 0);

    await chromeSmoke(server.port, workDir, { width: 1440, height: 900 });
    await chromeSmoke(server.port, workDir, { width: 390, height: 844 });
  } finally {
    await server.close();
    await rm(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
