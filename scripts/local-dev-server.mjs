#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile, stat, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import worker, { hashInviteCode } from "../apps/worker/src/index.js";
import { MemoryBucket, MemoryStore } from "../apps/worker/src/testing.js";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const LOCAL_INVITE_CODE = process.env.LOCAL_INVITE_CODE || "LOCAL-DEMO";
const INVITE_SECRET = "local-dev-invite-secret";
const UPLOAD_SECRET = "local-dev-upload-secret";
const PROCESSOR_TOKEN = "local-dev-processor-token";

function parsePort() {
  const index = process.argv.indexOf("--port");
  if (index !== -1 && process.argv[index + 1]) {
    return Number(process.argv[index + 1]);
  }
  return Number(process.env.PORT || 8787);
}

function contentType(pathname) {
  const ext = extname(pathname);
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function staticAssets(directory) {
  const root = resolve(directory);
  return {
    async fetch(request) {
      const url = new URL(request.url);
      const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
      const target = resolve(root, `.${pathname}`);
      if (!target.startsWith(root)) {
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

function runProcessor(jobId, port, workDir) {
  const child = spawn(
    "python3",
    [
      "processor/process_job.py",
      "--job-id",
      jobId,
      "--api-base",
      `http://127.0.0.1:${port}`,
      "--processor-token",
      PROCESSOR_TOKEN,
      "--template-dir",
      "template",
      "--work-dir",
      workDir,
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }
  );

  child.stdout.on("data", (chunk) => process.stdout.write(`[processor] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[processor] ${chunk}`));
  child.on("close", (code) => {
    if (code === 0) {
      console.log(`[processor] job ${jobId} finished`);
    } else {
      console.log(`[processor] job ${jobId} exited with ${code}`);
    }
  });
}

function requestToWorkerRequest(incoming, effectiveHost) {
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
  return new Request(url, {
    method: incoming.method,
    headers,
    body: hasBody ? incoming : undefined,
    duplex: hasBody ? "half" : undefined,
  });
}

async function writeResponse(outgoing, response) {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body) {
    Readable.fromWeb(response.body).pipe(outgoing);
  } else {
    outgoing.end();
  }
}

async function main() {
  const port = parsePort();
  const store = new MemoryStore();
  store.addInvite(await hashInviteCode(LOCAL_INVITE_CODE, INVITE_SECRET), 100);
  const env = {
    __TEST_STORE: store,
    __TEST_BUCKET: new MemoryBucket(),
    ASSETS: staticAssets(join(ROOT, "apps/web")),
    INVITE_HASH_SECRET: INVITE_SECRET,
    UPLOAD_TOKEN_SECRET: UPLOAD_SECRET,
    PROCESSOR_TOKEN,
    PUBLIC_HOST_SUFFIX: "runs.localhost",
    PUBLIC_SITE_URL_PATTERN: `http://{slug}.runs.localhost:${port}`,
    MAX_ZIP_BYTES: String(500 * 1024 * 1024),
    DEFAULT_MAX_POINTS: "900000",
  };
  const workDir = await mkdtemp(join(tmpdir(), "garmin-footprints-local-"));

  const server = createServer(async (incoming, outgoing) => {
    const effectiveHost = incoming.headers.host || `127.0.0.1:${port}`;
    const request = requestToWorkerRequest(incoming, effectiveHost);
    const pending = [];
    try {
      const response = await worker.fetch(request, env, {
        waitUntil(promise) {
          pending.push(promise);
        },
      });

      if (incoming.method === "PUT" && incoming.url?.startsWith("/api/uploads/") && response.ok) {
        const clone = response.clone();
        await writeResponse(outgoing, response);
        const payload = await clone.json().catch(() => null);
        if (payload?.jobId) {
          runProcessor(payload.jobId, port, workDir);
        }
      } else {
        await writeResponse(outgoing, response);
      }
      await Promise.allSettled(pending);
    } catch (error) {
      console.error(error);
      if (!outgoing.headersSent) {
        outgoing.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      }
      outgoing.end(String(error?.stack || error));
    }
  });

  server.listen(port, "127.0.0.1", () => {
    console.log("Garmin Footprints local server");
    console.log(`Upload app:  http://127.0.0.1:${port}/`);
    console.log(`Invite code: ${LOCAL_INVITE_CODE}`);
    console.log(`Share URLs:  http://{slug}.runs.localhost:${port}/`);
    console.log("Uploads are processed automatically in this local dev server.");
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
