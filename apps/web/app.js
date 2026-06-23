/**
 * @template {HTMLElement} T
 * @param {string} id
 * @param {new (...args: never[]) => T} type
 * @returns {T}
 */
function mustElement(id, type) {
  const element = document.getElementById(id);
  if (!(element instanceof type)) {
    throw new Error(`Missing #${id}`);
  }
  return element;
}

/** @typedef {{ render(target: HTMLElement, options: Record<string, unknown>): string | number, reset(id: string | number): void }} Turnstile */
/** @type {Window & typeof globalThis & { turnstile?: Turnstile }} */
const browserWindow = window;

const form =
  /** @type {HTMLFormElement & { inviteCode: HTMLInputElement, slug: HTMLInputElement, displayName: HTMLInputElement }} */ (
    mustElement("uploadForm", HTMLFormElement)
  );
const fileInput = mustElement("zipFile", HTMLInputElement);
const fileLabel = mustElement("fileLabel", HTMLSpanElement);
const submitButton = mustElement("submitButton", HTMLButtonElement);
const statusText = mustElement("statusText", HTMLParagraphElement);
const meterFill = mustElement("meterFill", HTMLSpanElement);
const shareLink = mustElement("shareLink", HTMLAnchorElement);
const turnstileSlot = mustElement("turnstileSlot", HTMLDivElement);
const turnstileToken = mustElement("turnstileToken", HTMLInputElement);
const readinessChecks = Array.from(document.querySelectorAll(".checklist input[type='checkbox']")).map((element) => {
  if (!(element instanceof HTMLInputElement)) {
    throw new Error("Readiness checklist input was not an input element.");
  }
  return element;
});

let activePoll = null;
let submitting = false;
let turnstileRequired = false;
let turnstileWidgetId = null;
let maxZipBytes = null;

const ERROR_MESSAGES = {
  GARMIN_EXPORT_NOT_FOUND: "This ZIP does not contain Garmin account export folders.",
  GARMIN_ACTIVITY_FILES_MISSING: "Garmin export found, but activity files were missing.",
  NO_RUNS_FOUND: "No running GPS activities were found.",
  ZIP_TOO_LARGE: "The ZIP is too large or unusually compressed.",
  ZIP_UNUSUAL_COMPRESSION: "The ZIP is too large or unusually compressed.",
  INVALID_ZIP: "This ZIP could not be validated as a safe Garmin account export.",
  LENGTH_REQUIRED: "Your browser did not send a required upload size. Try a different browser or file picker.",
  INVALID_UPLOAD_TOKEN: "This upload session expired. Start the upload again.",
};

function setStatus(message, progress = null) {
  statusText.textContent = message;
  if (typeof progress === "number") {
    meterFill.style.width = `${Math.max(0, Math.min(100, progress))}%`;
  }
}

function showShareUrl(url) {
  shareLink.hidden = false;
  shareLink.href = url;
  shareLink.textContent = url;
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
    throw new Error(messageForError(payload) || `Request failed with ${response.status}`);
  }
  return payload;
}

function messageForError(payload = {}) {
  return ERROR_MESSAGES[payload.errorCode] || payload.errorMessage || payload.errorCode || "";
}

function formatBytes(bytes) {
  const mib = bytes / (1024 * 1024);
  return `${Math.floor(mib)} MB`;
}

function classifyFileError(file) {
  if (!file) return "Choose a Garmin ZIP first.";
  if (file.size === 0) {
    return "This file is empty. If it is an iCloud or Dropbox placeholder, download the real Garmin ZIP first.";
  }
  if (maxZipBytes && file.size > maxZipBytes) {
    return `This ZIP is ${formatBytes(file.size)}. The current upload limit is ${formatBytes(maxZipBytes)}.`;
  }
  const name = file.name.toLowerCase();
  if (name.endsWith(".fit") || name.endsWith(".gpx") || name.endsWith(".tcx")) {
    return "This looks like a single activity file. Please upload the full Garmin account export ZIP.";
  }
  if (!name.endsWith(".zip")) {
    return "Upload the Garmin export ZIP unchanged.";
  }
  return "";
}

function checklistReady() {
  return readinessChecks.every((input) => input.checked);
}

function updateSubmitAvailability({ quiet = true } = {}) {
  const [file] = fileInput.files;
  const fileError = classifyFileError(file);
  const turnstileMissing = turnstileRequired && !turnstileToken.value;
  const ready = !submitting && checklistReady() && !fileError && !turnstileMissing;
  submitButton.disabled = !ready;
  if (!quiet) {
    if (!checklistReady()) {
      setStatus("Complete the readiness checklist before uploading.", 0);
    } else if (fileError) {
      setStatus(fileError, 0);
    } else if (turnstileMissing) {
      setStatus("Complete the browser check before uploading.", 0);
    } else {
      setStatus("Ready to upload the Garmin account export ZIP.", 0);
    }
  }
}

function uploadFile(uploadUrl, file) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", uploadUrl);
    request.setRequestHeader("Content-Type", "application/zip");
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) {
        setStatus("Uploading Garmin ZIP...", 15 + (event.loaded / event.total) * 55);
      }
    });
    request.addEventListener("load", () => {
      if (request.status >= 200 && request.status < 300) {
        resolve();
        return;
      }
      let message = `Upload failed with ${request.status}`;
      try {
        const payload = JSON.parse(request.responseText);
        message = messageForError(payload) || message;
      } catch {
        // Keep the HTTP status fallback.
      }
      reject(new Error(message));
    });
    request.addEventListener("error", () => reject(new Error("Upload failed.")));
    request.send(file);
  });
}

async function pollJob(jobId) {
  if (activePoll) {
    clearTimeout(activePoll);
  }
  const job = await apiFetch(`/api/jobs/${jobId}`, { headers: {} });
  if (job.status === "ready") {
    setStatus("Your running map is ready.", 100);
    showShareUrl(job.siteUrl);
    submitting = false;
    submitButton.textContent = "Start upload";
    updateSubmitAvailability();
    return;
  }
  if (job.status === "failed") {
    throw new Error(messageForError(job) || "Processing failed.");
  }
  if (job.status === "expired") {
    throw new Error("This upload session expired before processing started. Start a new upload.");
  }
  const statusLabel = job.status === "processing" ? "Processing running GPS data..." : "Waiting for processing...";
  setStatus(statusLabel, job.status === "processing" ? 82 : 72);
  activePoll = setTimeout(() => pollJob(jobId).catch(handleError), 2500);
}

function handleError(error) {
  setStatus(error instanceof Error ? error.message : String(error), 0);
  submitting = false;
  submitButton.textContent = "Start upload";
  updateSubmitAvailability();
}

fileInput.addEventListener("change", () => {
  const [file] = fileInput.files;
  fileLabel.textContent = file ? file.name : "Choose Garmin ZIP";
  updateSubmitAvailability({ quiet: false });
});

for (const input of readinessChecks) {
  input.addEventListener("change", () => updateSubmitAvailability({ quiet: false }));
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  shareLink.hidden = true;
  const [file] = fileInput.files;
  const fileError = classifyFileError(file);
  if (!checklistReady()) {
    setStatus("Complete the readiness checklist before uploading.", 0);
    return;
  }
  if (fileError) {
    setStatus(fileError, 0);
    return;
  }
  if (turnstileRequired && !turnstileToken.value) {
    setStatus("Complete the browser check before uploading.", 0);
    return;
  }

  submitting = true;
  updateSubmitAvailability();
  submitButton.textContent = "Uploading...";
  setStatus("Reserving your slug...", 8);

  try {
    const session = await apiFetch("/api/upload-sessions", {
      method: "POST",
      body: JSON.stringify({
        inviteCode: form.inviteCode.value,
        slug: form.slug.value,
        displayName: form.displayName.value,
        turnstileToken: turnstileToken.value,
      }),
    });
    await uploadFile(session.uploadUrl, file);
    setStatus("Upload complete. Processing is queued...", 72);
    await pollJob(session.jobId);
  } catch (error) {
    resetTurnstile();
    handleError(error);
  }
});

async function initTurnstile() {
  try {
    const config = await apiFetch("/api/config", { headers: {} });
    maxZipBytes = Number.isFinite(Number(config.maxZipBytes)) ? Number(config.maxZipBytes) : null;
    if (!config.turnstileSiteKey) {
      updateSubmitAvailability();
      return;
    }
    turnstileRequired = true;
    turnstileSlot.hidden = false;
    await loadTurnstileScript();
    turnstileWidgetId = browserWindow.turnstile.render(turnstileSlot, {
      sitekey: config.turnstileSiteKey,
      callback(token) {
        turnstileToken.value = token;
        updateSubmitAvailability({ quiet: false });
      },
      "expired-callback"() {
        turnstileToken.value = "";
        updateSubmitAvailability({ quiet: false });
      },
      "error-callback"() {
        turnstileToken.value = "";
        setStatus("Browser check failed. Refresh the page and try again.", 0);
        updateSubmitAvailability();
      },
    });
  } catch {
    setStatus("Upload app loaded, but production configuration could not be checked.", 0);
  }
  updateSubmitAvailability();
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

updateSubmitAvailability();
initTurnstile();
