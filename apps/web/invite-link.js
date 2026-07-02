/**
 * @param {string} hash
 * @returns {string | null}
 */
export function inviteCodeFromHash(hash) {
  if (!String(hash || "").startsWith("#")) return null;
  const fragment = String(hash || "").replace(/^#/, "");
  if (!fragment) return null;
  const code = new URLSearchParams(fragment).get("invite")?.trim() || "";
  return code || null;
}

/**
 * @param {{ pathname: string, search: string }} location
 * @returns {string}
 */
export function inviteCleanUrl(location) {
  return `${location.pathname || "/"}${location.search || ""}`;
}

/**
 * @param {{ location: Location, history: History }} browser
 * @param {HTMLInputElement} input
 * @param {HTMLElement} hint
 * @returns {string | null}
 */
export function initInvitePrefill(browser, input, hint) {
  const inviteCode = inviteCodeFromHash(browser.location.hash);
  if (!inviteCode) return null;

  input.value = inviteCode;
  hint.hidden = false;
  browser.history.replaceState(browser.history.state, "", inviteCleanUrl(browser.location));

  input.addEventListener("input", () => {
    hint.hidden = input.value.trim() !== inviteCode;
  });

  return inviteCode;
}
