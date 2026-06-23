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
  return new Request(
    url,
    /** @type {RequestInit & { duplex?: "half" }} */ ({
      method: incoming.method,
      headers,
      body: hasBody ? incoming : undefined,
      duplex: hasBody ? "half" : undefined,
    })
  );
}

async function writeResponse(outgoing, response) {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body) {
    Readable.fromWeb(/** @type {any} */ (response.body)).pipe(outgoing);
  } else {
    outgoing.end();
  }
}

async function handleFakeR2PartUpload(incoming, outgoing, env) {
  const url = new URL(`http://127.0.0.1${incoming.url}`);
  const jobId = decodeURIComponent(url.pathname.replace(/^\/__r2\//, ""));
  const partNumber = Number(url.searchParams.get("partNumber"));
  const uploadId = url.searchParams.get("uploadId");
  const job = env.__TEST_STORE.jobs.get(jobId);
  if (!job || uploadId !== job.uploadId || !Number.isInteger(partNumber)) {
    outgoing.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    outgoing.end("Unknown multipart upload");
    return;
  }
  const upload = env.__TEST_BUCKET.resumeMultipartUpload(job.uploadKey, uploadId);
  const part = await upload.uploadPart(partNumber, incoming);
  outgoing.writeHead(200, {
    ETag: part.etag,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "ETag",
  });
  outgoing.end();
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
    MAX_ZIP_BYTES: String(1024 * 1024 * 1024),
    __TEST_R2_UPLOAD_BASE: `http://127.0.0.1:${port}`,
    DEFAULT_MAX_POINTS: "900000",
  };
  const workDir = await mkdtemp(join(tmpdir(), "garmin-footprints-local-"));

  const server = createServer(async (incoming, outgoing) => {
    const effectiveHost = incoming.headers.host || `127.0.0.1:${port}`;
    const pending = [];
    try {
      if (incoming.method === "OPTIONS" && incoming.url?.startsWith("/__r2/")) {
        outgoing.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "PUT,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "3600",
        });
        outgoing.end();
        return;
      }
      if (incoming.method === "PUT" && incoming.url?.startsWith("/__r2/")) {
        await handleFakeR2PartUpload(incoming, outgoing, env);
        return;
      }

      const request = requestToWorkerRequest(incoming, effectiveHost);
      const response = await worker.fetch(request, env, {
        waitUntil(promise) {
          pending.push(promise);
        },
      });

      if (incoming.method === "POST" && /^\/api\/uploads\/[^/]+\/complete$/.test(incoming.url || "") && response.ok) {
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

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen(undefined);
    });
  });

  console.log("Garmin Footprints local server");
  console.log(`Upload app:  http://127.0.0.1:${port}/`);
  console.log(`Invite code: ${LOCAL_INVITE_CODE}`);
  console.log(`Share URLs:  http://{slug}.runs.localhost:${port}/`);
  console.log("Uploads are processed automatically in this local dev server.");

  await new Promise((resolveShutdown) => {
    const shutdown = () => {
      server.close(() => resolveShutdown(undefined));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
