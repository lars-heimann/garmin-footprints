/**
 * @template {HTMLElement} T
 * @param {string} id
 * @param {new (...args: never[]) => T} type
 * @returns {T}
 */
function mustElement(id, type) {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`Missing #${id}`);
  return element;
}

/** @typedef {{ render(target: HTMLElement, options: Record<string, unknown>): string | number, reset(id: string | number): void }} Turnstile */
/** @type {Window & typeof globalThis & { turnstile?: Turnstile }} */
const browserWindow = window;

const form = /** @type {HTMLFormElement & { inviteCode: HTMLInputElement, displayName: HTMLInputElement }} */ (
  mustElement("uploadForm", HTMLFormElement)
);
const fileInput = mustElement("zipFile", HTMLInputElement);
const fileLabel = mustElement("fileLabel", HTMLSpanElement);
const previewButton = mustElement("previewButton", HTMLButtonElement);
const publishButton = mustElement("publishButton", HTMLButtonElement);
const cancelLocalButton = mustElement("cancelLocalButton", HTMLButtonElement);
const clearPreviewButton = mustElement("clearPreviewButton", HTMLButtonElement);
const statusText = mustElement("statusText", HTMLParagraphElement);
const meterFill = mustElement("meterFill", HTMLSpanElement);
const shareLink = mustElement("shareLink", HTMLAnchorElement);
const deleteLink = mustElement("deleteLink", HTMLAnchorElement);
const localPreviewPanel = mustElement("localPreviewPanel", HTMLElement);
const localPreviewFrame = mustElement("localPreviewFrame", HTMLIFrameElement);
const publishFields = mustElement("publishFields", HTMLFieldSetElement);
const turnstileSlot = mustElement("turnstileSlot", HTMLDivElement);
const turnstileToken = mustElement("turnstileToken", HTMLInputElement);
const errorSummary = mustElement("errorSummary", HTMLElement);
const previewUrlText = mustElement("previewUrlText", HTMLParagraphElement);
const guideDialog = mustElement("guideDialog", HTMLDialogElement);
const guideButton = mustElement("guideButton", HTMLButtonElement);
const closeGuideButton = mustElement("closeGuideButton", HTMLButtonElement);
const readinessChecks = Array.from(document.querySelectorAll("#previewChecklist input[type='checkbox']")).map(
  (element) => {
    if (!(element instanceof HTMLInputElement)) throw new Error("Checklist input was not an input element.");
    return element;
  }
);

const LOCAL_MAX_ZIP_BYTES = 500 * 1024 * 1024;
const ERROR_MESSAGES = {
  INVALID_INVITE: "Invite code was not found.",
  INVITE_EXHAUSTED: "Invite code has no remaining uses.",
  TURNSTILE_REQUIRED: "Complete the browser check before publishing.",
  TURNSTILE_FAILED: "Browser check failed.",
  INVALID_DISPLAY_NAME: "Display name must contain at least 2 letters or numbers.",
  SLUG_GENERATION_FAILED: "Could not reserve a public URL. Try publishing again.",
  ASSET_TOO_LARGE: "Generated map files are larger than allowed.",
  PUBLISH_ASSETS_MISSING: "Generated map files were missing. Preview again, then publish.",
  POINTS_SIZE_MISMATCH: "Generated points file did not match metadata. Preview again, then publish.",
};

let submitting = false;
let turnstileRequired = false;
let turnstileWidgetId = null;
let turnstileSiteKey = null;
let localWorker = null;
let localPreviewData = null;
let maxMetaBytes = 1024 * 1024;
let maxPointsBytes = 32 * 1024 * 1024;

function setStatus(message, progress = null) {
  statusText.textContent = message;
  if (typeof progress === "number") {
    meterFill.style.width = `${Math.max(0, Math.min(100, progress))}%`;
  }
}

function showErrors(errors) {
  if (!errors.length) {
    errorSummary.hidden = true;
    errorSummary.replaceChildren();
    return;
  }
  const list = document.createElement("ul");
  for (const error of errors) {
    const item = document.createElement("li");
    item.textContent = error.message;
    list.append(item);
  }
  errorSummary.replaceChildren(list);
  errorSummary.hidden = false;
  errorSummary.focus();
  for (const error of errors) {
    error.element?.classList.add("field-error");
  }
  const first = errors[0]?.element;
  first?.scrollIntoView({ block: "center", behavior: "smooth" });
  if (typeof first?.focus === "function") first.focus({ preventScroll: true });
}

function clearErrors() {
  showErrors([]);
  for (const element of document.querySelectorAll(".field-error")) {
    element.classList.remove("field-error");
  }
}

function readJson(response) {
  return response.json().catch(() => ({}));
}

async function apiFetch(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(
      ERROR_MESSAGES[payload.errorCode] || payload.errorMessage || payload.errorCode || "Request failed."
    );
  }
  return payload;
}

function formatBytes(bytes) {
  return `${Math.floor(bytes / (1024 * 1024))} MB`;
}

function slugBaseFromDisplayName(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 34)
    .replace(/-$/g, "");
}

function possessiveTitle(displayName) {
  const name = displayName.trim();
  if (!name) return "Running Footprints";
  return `${name}${name.toLowerCase().endsWith("s") ? "'" : "'s"} Running Footprints`;
}

function updatePreviewCopy() {
  const base = slugBaseFromDisplayName(form.displayName.value);
  if (base.length < 2) {
    previewUrlText.textContent = "Public URL preview appears after you enter a display name.";
    return;
  }
  previewUrlText.textContent = `Preview: ${base}-9dgf2.runmaps.larsheimann.com · ${possessiveTitle(form.displayName.value)}`;
}

function classifyFileError(file) {
  if (!file) return "Choose a Garmin ZIP first.";
  if (file.size === 0) return "This file is empty. If it is an iCloud or Dropbox placeholder, download it first.";
  if (file.size > LOCAL_MAX_ZIP_BYTES) {
    return `This ZIP is ${formatBytes(file.size)}. The browser processing limit is ${formatBytes(LOCAL_MAX_ZIP_BYTES)}.`;
  }
  const name = file.name.toLowerCase();
  if (name.endsWith(".fit") || name.endsWith(".gpx") || name.endsWith(".tcx")) {
    return "This looks like a single activity file. Upload the full Garmin account export ZIP.";
  }
  if (!name.endsWith(".zip")) return "Upload the Garmin account export ZIP unchanged.";
  return "";
}

function validatePreview() {
  clearErrors();
  const errors = [];
  const displayName = form.displayName.value.trim();
  if (slugBaseFromDisplayName(displayName).length < 2) {
    errors.push({ message: "Display name must contain at least 2 letters or numbers.", element: form.displayName });
  }
  const [file] = fileInput.files;
  const fileError = classifyFileError(file);
  if (fileError) errors.push({ message: fileError, element: fileInput.closest(".file-drop") || fileInput });
  const missingChecks = readinessChecks.filter((input) => !input.checked);
  if (missingChecks.length) {
    errors.push({
      message: "Complete the preview readiness checklist.",
      element: mustElement("previewChecklist", HTMLElement),
    });
  }
  return errors;
}

function validatePublish() {
  clearErrors();
  const errors = [];
  if (!localPreviewData) {
    errors.push({ message: "Preview your map locally before publishing.", element: previewButton });
  }
  if (!form.inviteCode.value.trim()) {
    errors.push({ message: "Invite code is required to publish.", element: form.inviteCode });
  }
  if (turnstileRequired && !turnstileToken.value) {
    errors.push({ message: "Complete the browser check before publishing.", element: turnstileSlot });
  }
  return errors;
}

function resetLocalWorker() {
  if (localWorker) {
    localWorker.terminate();
    localWorker = null;
  }
  cancelLocalButton.hidden = true;
}

function clearPreview() {
  localPreviewData = null;
  localPreviewPanel.hidden = true;
  localPreviewFrame.removeAttribute("src");
  clearPreviewButton.hidden = true;
  publishButton.hidden = true;
  publishFields.hidden = true;
  turnstileSlot.hidden = true;
  resetTurnstile();
  shareLink.hidden = true;
  deleteLink.hidden = true;
}

function renderLocalPreview(meta, points) {
  localPreviewData = { meta, points };
  localPreviewPanel.hidden = false;
  clearPreviewButton.hidden = false;
  publishButton.hidden = false;
  publishFields.hidden = false;
  ensureTurnstile().catch(() => {
    setStatus("Browser check could not load. Refresh the page and try again.", 0);
  });
  localPreviewFrame.src = "./viewer/index.html";
}

function processLocally(file) {
  resetLocalWorker();
  clearPreview();
  return new Promise((resolve, reject) => {
    localWorker = new Worker("./browser-processing/processor-worker.js", { type: "module" });
    cancelLocalButton.hidden = false;
    localWorker.addEventListener("message", (event) => {
      const { type, progress, meta, points, message } = event.data || {};
      if (type === "progress") {
        setStatus(progress.message || "Processing locally...", phaseProgress(progress.phase));
        return;
      }
      if (type === "complete") {
        resetLocalWorker();
        setStatus("Local preview is ready. Your Garmin ZIP stayed in this browser.", 100);
        renderLocalPreview(meta, points);
        resolve();
        return;
      }
      if (type === "error") {
        resetLocalWorker();
        reject(new Error(message || "Local processing failed."));
      }
    });
    localWorker.addEventListener("error", (event) => {
      resetLocalWorker();
      reject(new Error(event.message || "Local processing worker failed. Try a modern browser with enough memory."));
    });
    localWorker.postMessage({
      type: "process",
      file,
      options: {
        displayName: form.displayName.value.trim(),
        slug: "local-preview",
        startDate: "2022-05-01",
        maxPoints: 900000,
      },
    });
  });
}

function phaseProgress(phase) {
  return { validating: 8, summaries: 18, "activity-zips": 30, fit: 58, generating: 88 }[phase] || 20;
}

async function previewLocally() {
  const errors = validatePreview();
  if (errors.length) {
    showErrors(errors);
    setStatus("Some required preview details are missing.", 0);
    return;
  }
  const [file] = fileInput.files;
  submitting = true;
  previewButton.textContent = "Processing...";
  setStatus("Starting local processor...", 8);
  try {
    await processLocally(file);
  } catch (error) {
    resetLocalWorker();
    setStatus(error instanceof Error ? error.message : String(error), 0);
  } finally {
    submitting = false;
    previewButton.textContent = "Preview locally";
  }
}

async function uploadAsset(session, name, body, contentType) {
  const maxBytes = name === "meta.json" ? maxMetaBytes : maxPointsBytes;
  const size = body instanceof Blob ? body.size : body.byteLength;
  if (size > maxBytes) throw new Error(`${name} is larger than allowed.`);
  const response = await fetch(session.assetUrls[name], {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${session.publishToken}`,
      "Content-Type": contentType,
    },
    body,
  });
  if (!response.ok) {
    const payload = await readJson(response);
    throw new Error(ERROR_MESSAGES[payload.errorCode] || payload.errorMessage || `${name} upload failed.`);
  }
}

async function publishMap() {
  const errors = validatePublish();
  if (errors.length) {
    showErrors(errors);
    setStatus("Some required publishing details are missing.", 0);
    return;
  }
  submitting = true;
  publishButton.textContent = "Publishing...";
  setStatus("Reserving public URL...", 5);
  try {
    const session = await apiFetch("/api/publish-sessions", {
      method: "POST",
      body: JSON.stringify({
        inviteCode: form.inviteCode.value,
        displayName: form.displayName.value,
        turnstileToken: turnstileToken.value,
      }),
    });
    maxMetaBytes = session.maxMetaBytes || maxMetaBytes;
    maxPointsBytes = session.maxPointsBytes || maxPointsBytes;
    const meta = { ...localPreviewData.meta, displayName: form.displayName.value.trim() };
    setStatus("Uploading generated metadata...", 25);
    await uploadAsset(
      session,
      "meta.json",
      new Blob([JSON.stringify(meta)], { type: "application/json" }),
      "application/json"
    );
    setStatus("Uploading generated points...", 55);
    const pointsBytes = localPreviewData.points.buffer.slice(
      localPreviewData.points.byteOffset,
      localPreviewData.points.byteOffset + localPreviewData.points.byteLength
    );
    await uploadAsset(
      session,
      "points.bin",
      new Blob([pointsBytes], { type: "application/octet-stream" }),
      "application/octet-stream"
    );
    setStatus("Finalizing public map...", 85);
    const done = await apiFetch(`/api/publish-sessions/${session.jobId}/complete`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.publishToken}` },
      body: "{}",
    });
    setStatus("Your running map is public for 30 days.", 100);
    shareLink.hidden = false;
    shareLink.href = done.siteUrl;
    shareLink.textContent = done.siteUrl;
    deleteLink.hidden = false;
    deleteLink.href = session.deleteUrl;
    deleteLink.textContent = "Private delete link";
    resetTurnstile();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 0);
    resetTurnstile();
  } finally {
    submitting = false;
    publishButton.textContent = "Publish map";
  }
}

fileInput.addEventListener("change", () => {
  const [file] = fileInput.files;
  fileLabel.textContent = file ? file.name : "Choose Garmin ZIP";
  clearPreview();
});
form.displayName.addEventListener("input", () => {
  updatePreviewCopy();
  clearPreview();
});
for (const input of readinessChecks) input.addEventListener("change", clearPreview);
previewButton.addEventListener("click", () => {
  if (!submitting) previewLocally();
});
publishButton.addEventListener("click", () => {
  if (!submitting) publishMap();
});
cancelLocalButton.addEventListener("click", () => {
  localWorker?.postMessage({ type: "cancel" });
  resetLocalWorker();
  setStatus("Processing was canceled.", 0);
});
clearPreviewButton.addEventListener("click", () => {
  clearPreview();
  setStatus("Waiting for a Garmin ZIP.", 0);
});
guideButton.addEventListener("click", () => guideDialog.showModal());
closeGuideButton.addEventListener("click", () => guideDialog.close());

window.addEventListener("message", (event) => {
  if (event.source !== localPreviewFrame.contentWindow || event.data?.type !== "runmaps-viewer-ready") return;
  if (!localPreviewData) return;
  const pointsBuffer = localPreviewData.points.buffer.slice(
    localPreviewData.points.byteOffset,
    localPreviewData.points.byteOffset + localPreviewData.points.byteLength
  );
  localPreviewFrame.contentWindow.postMessage(
    { type: "runmaps-local-data", meta: localPreviewData.meta, points: pointsBuffer },
    window.location.origin,
    [pointsBuffer]
  );
});

async function initTurnstile() {
  try {
    const config = await apiFetch("/api/config", { headers: {} });
    maxMetaBytes = Number(config.maxMetaBytes || maxMetaBytes);
    maxPointsBytes = Number(config.maxPointsBytes || maxPointsBytes);
    if (!config.turnstileSiteKey) return;
    turnstileRequired = true;
    turnstileSiteKey = config.turnstileSiteKey;
  } catch {
    setStatus("Upload app loaded, but production configuration could not be checked.", 0);
  }
}

async function ensureTurnstile() {
  if (!turnstileRequired || !turnstileSiteKey || turnstileWidgetId !== null) return;
  turnstileSlot.hidden = false;
  await loadTurnstileScript();
  turnstileWidgetId = browserWindow.turnstile.render(turnstileSlot, {
    sitekey: turnstileSiteKey,
    callback(token) {
      turnstileToken.value = token;
    },
    "expired-callback"() {
      turnstileToken.value = "";
    },
    "error-callback"() {
      turnstileToken.value = "";
      setStatus("Browser check failed. Refresh the page and try again.", 0);
    },
  });
}

function loadTurnstileScript() {
  if (browserWindow.turnstile) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error("Turnstile failed to load."));
    document.head.append(script);
  });
}

function resetTurnstile() {
  if (browserWindow.turnstile && turnstileWidgetId !== null) {
    browserWindow.turnstile.reset(turnstileWidgetId);
    turnstileToken.value = "";
  }
}

updatePreviewCopy();
initTurnstile();
