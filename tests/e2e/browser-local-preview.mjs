import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);

function contentType(path) {
  const ext = extname(path);
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".zip") return "application/zip";
  return "application/octet-stream";
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

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const { timeoutMs = 30000, allowTimeoutFile = null, allowTimeoutPattern = null, ...spawnOptions } = options;
    const child = spawn(command, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], ...spawnOptions });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      if (allowTimeoutPattern?.test(stdout)) {
        if (!allowTimeoutFile) {
          resolveRun({ stdout, stderr, timedOutAfterOutput: true });
          return;
        }
        stat(allowTimeoutFile)
          .then((info) => {
            if (info.size > 1000) {
              resolveRun({ stdout, stderr, timedOutAfterOutput: true });
            } else {
              rejectRun(
                new Error(
                  `${command} ${args.join(" ")} timed out after ${timeoutMs}ms with an incomplete output file\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`
                )
              );
            }
          })
          .catch(() => {
            rejectRun(
              new Error(
                `${command} ${args.join(" ")} timed out after ${timeoutMs}ms without an output file\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`
              )
            );
          });
        return;
      }
      rejectRun(
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
      clearTimeout(timer);
      rejectRun(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolveRun({ stdout, stderr });
      } else {
        rejectRun(new Error(`${command} ${args.join(" ")} exited ${code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
      }
    });
  });
}

function harnessHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Browser local preview harness</title>
    <style>
      html, body { margin: 0; min-height: 100%; font: 16px system-ui, sans-serif; background: #101114; color: #f7f4ee; }
      #status { position: fixed; z-index: 2; top: 12px; left: 12px; padding: 8px 10px; background: #1c352c; border: 1px solid #72d4a5; }
      iframe { width: 100vw; height: 100vh; border: 0; display: block; }
    </style>
  </head>
  <body>
    <p id="status">starting</p>
    <iframe id="viewer" src="/viewer/index.html"></iframe>
    <script type="module">
      import { buildVisualizationFromGarminFile } from "/browser-processing/processor-core.js";

      const status = document.getElementById("status");
      const frame = document.getElementById("viewer");

      function setStatus(message) {
        status.textContent = message;
        document.body.dataset.status = message;
      }

      function waitForViewerRender() {
        return new Promise((resolve, reject) => {
          const deadline = Date.now() + 15000;
          const timer = setInterval(() => {
            const doc = frame.contentDocument;
            const pointCount = doc?.getElementById("pointCount")?.textContent || "";
            const canvas = doc?.getElementById("scene");
            const error = doc?.getElementById("error");
            if (error && !error.hidden) {
              clearInterval(timer);
              reject(new Error(error.textContent || "viewer error"));
              return;
            }
            if (pointCount && pointCount !== "..." && canvas?.width > 0 && canvas?.height > 0) {
              clearInterval(timer);
              resolve();
              return;
            }
            if (Date.now() > deadline) {
              clearInterval(timer);
              reject(new Error("viewer did not render local data"));
            }
          }, 100);
        });
      }

      try {
        setStatus("fetching");
        const file = await (await fetch("/__fixture/garmin.zip")).blob();
        setStatus("processing");
        const result = await buildVisualizationFromGarminFile(file, {
          displayName: "Browser E2E Runner",
          slug: "local-preview",
          startDate: "2022-05-01",
          maxPoints: 10000,
        });
        window.addEventListener("message", (event) => {
          if (event.source !== frame.contentWindow || event.data?.type !== "runmaps-viewer-ready") return;
          const buffer = result.points.buffer.slice(result.points.byteOffset, result.points.byteOffset + result.points.byteLength);
          frame.contentWindow.postMessage({ type: "runmaps-local-data", meta: result.meta, points: buffer }, window.location.origin, [buffer]);
        });
        await waitForViewerRender();
        setStatus("ready:" + result.meta.pointCount);
      } catch (error) {
        setStatus("error:" + (error?.message || error));
      }
    </script>
  </body>
</html>`;
}

async function startServer(root, fixtureZip, requests) {
  const appRoot = join(root, "apps/web");
  const server = createServer(async (request, response) => {
    requests.push(request.url || "");
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname === "/__harness") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(harnessHtml());
      return;
    }
    if (url.pathname === "/__fixture/garmin.zip") {
      response.writeHead(200, { "Content-Type": "application/zip" });
      response.end(await readFile(fixtureZip));
      return;
    }
    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    const target = resolve(appRoot, `.${pathname}`);
    if (!target.startsWith(resolve(appRoot))) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    try {
      const info = await stat(target);
      if (!info.isFile()) throw new Error("not a file");
      response.writeHead(200, { "Content-Type": contentType(target) });
      response.end(await readFile(target));
    } catch {
      response.writeHead(404);
      response.end("Not found");
    }
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen(undefined)));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local browser preview server did not expose a port.");
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolveClose) => server.close(resolveClose));
    },
  };
}

async function main() {
  const chrome = chromePath();
  if (!chrome) throw new Error("Chrome was not found for browser local-preview e2e. Set CHROME_PATH.");
  const workDir = await mkdtemp(join(tmpdir(), "runmaps-browser-local-e2e-"));
  const requests = [];
  const fixtureZip = join(workDir, "garmin.zip");
  await run("python3", ["processor/tests/fixtures.py", fixtureZip]);
  const server = await startServer(ROOT, fixtureZip, requests);
  try {
    const screenshot = join(workDir, "browser-local-preview.png");
    const dump = await run(
      chrome,
      [
        "--headless=new",
        "--disable-gpu",
        "--enable-unsafe-swiftshader",
        "--use-angle=swiftshader",
        "--disable-background-networking",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-extensions",
        "--no-first-run",
        "--no-default-browser-check",
        "--timeout=30000",
        `--user-data-dir=${join(workDir, "chrome")}`,
        "--window-size=1280,900",
        "--virtual-time-budget=30000",
        `--screenshot=${screenshot}`,
        "--dump-dom",
        `${server.url}/__harness`,
      ],
      {
        timeoutMs: 45000,
        allowTimeoutFile: screenshot,
        allowTimeoutPattern: /data-status="ready:[1-9][0-9]*"/,
      }
    );
    assert.match(dump.stdout, /data-status="ready:[1-9][0-9]*"/);
    assert.ok((await stat(screenshot)).size > 1000, "expected non-empty local preview screenshot");
    assert.ok(
      requests.some((path) => path === "/__fixture/garmin.zip"),
      "expected fixture fetch"
    );
    assert.equal(
      requests.some((path) => path.startsWith("/api/uploads") || path.startsWith("/api/upload-sessions")),
      false,
      `browser-only flow must not call upload APIs: ${requests.join(", ")}`
    );
  } finally {
    await server.close();
    await rm(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
