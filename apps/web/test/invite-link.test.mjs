import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { initInvitePrefill, inviteCleanUrl, inviteCodeFromHash } from "../invite-link.js";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function readWebFile(path) {
  return readFile(join(webRoot, path), "utf8");
}

function browserFixture(hash, pathname = "/", search = "") {
  return {
    location: /** @type {Location} */ ({ hash, pathname, search }),
    history: /** @type {History & { replacedUrl?: string }} */ ({
      state: { existing: true },
      replaceState(_state, _title, url) {
        this.replacedUrl = String(url);
      },
    }),
  };
}

function inputFixture() {
  const target = new EventTarget();
  return /** @type {HTMLInputElement & EventTarget} */ (
    Object.assign(target, {
      value: "",
    })
  );
}

function hintFixture() {
  return /** @type {HTMLElement} */ ({ hidden: true });
}

test("invite link helper reads only non-empty invite fragments", () => {
  assert.equal(inviteCodeFromHash("#invite=LOCAL-DEMO"), "LOCAL-DEMO");
  assert.equal(inviteCodeFromHash("#invite=RUNMAPS%20FRIENDS"), "RUNMAPS FRIENDS");
  assert.equal(inviteCodeFromHash("#invite=%20%20"), null);
  assert.equal(inviteCodeFromHash("#other=LOCAL-DEMO"), null);
  assert.equal(inviteCodeFromHash("?invite=LOCAL-DEMO"), null);
  assert.equal(inviteCodeFromHash(""), null);
});

test("invite link helper removes fragments while preserving path and query", () => {
  assert.equal(inviteCleanUrl({ pathname: "/", search: "" }), "/");
  assert.equal(inviteCleanUrl({ pathname: "/upload", search: "?intro=0" }), "/upload?intro=0");
});

test("invite prefill fills the field, cleans the URL, and lets manual override hide the hint", () => {
  const browser = browserFixture("#invite=LOCAL-DEMO", "/welcome", "?source=tester");
  const input = inputFixture();
  const hint = hintFixture();

  assert.equal(initInvitePrefill(browser, input, hint), "LOCAL-DEMO");
  assert.equal(input.value, "LOCAL-DEMO");
  assert.equal(hint.hidden, false);
  assert.equal(browser.history.replacedUrl, "/welcome?source=tester");

  input.value = "MANUAL-CODE";
  input.dispatchEvent(new Event("input"));
  assert.equal(hint.hidden, true);
});

test("invite prefill is a no-op without a valid fragment", () => {
  const browser = browserFixture("#invite=%20");
  const input = inputFixture();
  const hint = hintFixture();

  assert.equal(initInvitePrefill(browser, input, hint), null);
  assert.equal(input.value, "");
  assert.equal(hint.hidden, true);
  assert.equal(browser.history.replacedUrl, undefined);
});

test("upload app exposes invite prefill UI and module startup wiring", async () => {
  const [html, app, helper] = await Promise.all([
    readWebFile("index.html"),
    readWebFile("app.js"),
    readWebFile("invite-link.js"),
  ]);

  assert.match(html, /id="inviteLinkHint"[^>]*hidden/);
  assert.match(html, /Invite code added from your link\./);
  assert.match(html, /<script type="module" src="\.\/app\.js"><\/script>/);
  assert.match(app, /import \{ initInvitePrefill \} from "\.\/invite-link\.js";/);
  assert.match(app, /initInvitePrefill\(browserWindow, form\.inviteCode, inviteLinkHint\);/);
  assert.doesNotMatch(helper, /fetch\(/);
  assert.doesNotMatch(helper, /publish-sessions/);
});
