import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function readWebFile(path) {
  return readFile(join(webRoot, path), "utf8");
}

test("viewer keeps share controls hidden until a public map is loaded", async () => {
  const [html, css, app] = await Promise.all([
    readWebFile("viewer/index.html"),
    readWebFile("viewer/styles.css"),
    readWebFile("viewer/app.js"),
  ]);

  assert.match(html, /id="mapCta"[^>]*hidden/);
  assert.match(html, /id="collapseMapCta"/);
  assert.match(html, /id="shareMap"[^>]*hidden/);
  assert.match(html, /id="sharePrompt"[^>]*hidden/);
  assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important\s*;[^}]*\}/s);
  assert.match(app, /return window\.parent === window && !state\.meta\?\.localOnly;/);
  assert.match(app, /if \(!label \|\| !href\) \{/);
  assert.match(app, /mapCta\.classList\.add\("is-collapsed"\)/);
  assert.match(app, /if \(!isPublicViewer\(\)\) return;/);
});

test("viewer shares the canonical URL without turning copy into a path", async () => {
  const app = await readWebFile("viewer/app.js");

  assert.match(app, /return state\.meta\?\.siteUrl \|\| window\.location\.href;/);
  assert.match(app, /navigator\.share\(\{ title, url \}\)/);
  assert.doesNotMatch(app, /My running footprints map/);
});
