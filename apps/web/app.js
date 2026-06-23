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
const localModeButton = mustElement("localModeButton", HTMLButtonElement);
const uploadModeButton = mustElement("uploadModeButton", HTMLButtonElement);
const cancelLocalButton = mustElement("cancelLocalButton", HTMLButtonElement);
const clearPreviewButton = mustElement("clearPreviewButton", HTMLButtonElement);
const localPreviewPanel = mustElement("localPreviewPanel", HTMLElement);
const localPreviewFrame = mustElement("localPreviewFrame", HTMLIFrameElement);
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
let localMode = true;
let localWorker = null;
let localPreviewData = null;

const ERROR_MESSAGES = {
  GARMIN_EXPORT_NOT_FOUND: "This ZIP does not contain Garmin account export folders.",
  GARMIN_ACTIVITY_FILES_MISSING: "Garmin export found, but activity files were missing.",
  NO_RUNS_FOUND: "No running GPS activities were found.",
  ZIP_TOO_LARGE: "The ZIP is too large or unusually compressed.",
  ZIP_UNUSUAL_COMPRESSION: "The ZIP is too large or unusually compressed.",
  INVALID_ZIP: "This ZIP could not be validated as a safe Garmin account export.",
  LENGTH_REQUIRED: "Your browser did not send a required upload size. Try a different browser or file picker.",
  INVALID_UPLOAD_TOKEN: "This upload session expired. Start the upload again.",
  FILE_SIZE_REQUIRED: "Your browser did not provide the file size. Try a different browser or file picker.",
  INVALID_UPLOAD_SIZE: "The uploaded ZIP size did not match the upload session. Start a new upload.",
  INVALID_PARTS: "The upload parts did not match the selected ZIP. Start a new upload.",
  INVALID_PART_ETAG: "R2 returned an invalid upload response. Start a new upload.",
  MULTIPART_COMPLETE_FAILED: "Upload completion failed. Start a new upload.",
  UPLOAD_SIZE_MISMATCH: "The uploaded ZIP size did not match the upload session. Start a new upload.",
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

function setMode(nextMode) {
  localMode = nextMode === "local";
  document.body.classList.toggle("local-mode", localMode);
  document.body.classList.toggle("upload-mode", !localMode);
  localModeButton.classList.toggle("active", localMode);
  uploadModeButton.classList.toggle("active", !localMode);
  localModeButton.setAttribute("aria-pressed", String(localMode));
  uploadModeButton.setAttribute("aria-pressed", String(!localMode));
  submitButton.textContent = localMode ? "Preview locally" : "Start upload";
  setStatus(localMode ? "Waiting for a Garmin ZIP for local preview." : "Waiting for a Garmin ZIP.", 0);
  updateSubmitAvailability();
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
  if (!localMode && maxZipBytes && file.size > maxZipBytes) {
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
  return localMode || readinessChecks.every((input) => input.checked);
}

function updateSubmitAvailability({ quiet = true } = {}) {
  const [file] = fileInput.files;
  const fileError = classifyFileError(file);
  const turnstileMissing = !localMode && turnstileRequired && !turnstileToken.value;
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
      setStatus(
        localMode
          ? "Ready to process the Garmin account export ZIP locally."
          : "Ready to upload the Garmin account export ZIP.",
        0
      );
    }
  }
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
}

function renderLocalPreview(meta, points) {
  localPreviewData = { meta, points };
  localPreviewPanel.hidden = false;
  clearPreviewButton.hidden = false;
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
        setStatus("Local preview is ready. Raw ZIP stayed in this browser tab.", 100);
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
      reject(new Error(event.message || "Local processing worker failed. Desktop Chrome or Edge is recommended."));
    });
    localWorker.postMessage({
      type: "process",
      file,
      options: {
        displayName: form.displayName.value,
        slug: "local-preview",
        startDate: "2022-05-01",
        maxPoints: 900000,
      },
    });
  });
}

function phaseProgress(phase) {
  const progress = {
    validating: 8,
    summaries: 18,
    "activity-zips": 30,
    fit: 58,
    generating: 88,
  };
  return progress[phase] || 20;
}

function uploadPart(url, blob, partNumber, loadedByPart, totalSize) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) {
        loadedByPart.set(partNumber, event.loaded);
        const loaded = Array.from(loadedByPart.values()).reduce((total, value) => total + value, 0);
        setStatus("Uploading Garmin ZIP...", 15 + (loaded / totalSize) * 55);
      }
    });
    request.addEventListener("load", () => {
      if (request.status >= 200 && request.status < 300) {
        const etag = request.getResponseHeader("ETag");
        if (!etag) {
          reject(new Error("R2 did not return an ETag for an uploaded part."));
          return;
        }
        loadedByPart.set(partNumber, blob.size);
        resolve({ partNumber, etag });
        return;
      }
      reject(new Error(`Part ${partNumber} failed with ${request.status}`));
    });
    request.addEventListener("error", () =>
      reject(new Error("Part upload failed. Check R2 CORS and network connectivity."))
    );
    request.send(blob);
  });
}

function createPartUrlProvider(session, partCount) {
  const signedUrls = new Map();
  const inFlight = new Map();
  let nextToSign = 1;

  async function signPartNumbers(partNumbers) {
    const promise = apiFetch(`/api/uploads/${session.jobId}/parts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.uploadToken}` },
      body: JSON.stringify({ partNumbers }),
    });
    for (const partNumber of partNumbers) {
      inFlight.set(partNumber, promise);
    }
    try {
      const signed = await promise;
      for (const item of signed.urls || []) {
        signedUrls.set(Number(item.partNumber), item.url);
      }
    } finally {
      for (const partNumber of partNumbers) {
        inFlight.delete(partNumber);
      }
    }
  }

  async function signNextBatch() {
    const partNumbers = [];
    while (partNumbers.length < 8 && nextToSign <= partCount) {
      partNumbers.push(nextToSign);
      nextToSign += 1;
    }
    if (!partNumbers.length) return;
    await signPartNumbers(partNumbers);
  }

  return async function getPartUrl(partNumber, { fresh = false } = {}) {
    if (fresh) {
      signedUrls.delete(partNumber);
      await signPartNumbers([partNumber]);
    }
    while (!signedUrls.has(partNumber)) {
      const pending = inFlight.get(partNumber);
      if (pending) {
        await pending;
      } else {
        if (nextToSign > partCount) {
          throw new Error(`No signed upload URL was returned for part ${partNumber}.`);
        }
        await signNextBatch();
      }
    }
    const url = signedUrls.get(partNumber);
    if (!url) {
      throw new Error(`No signed upload URL was returned for part ${partNumber}.`);
    }
    return url;
  };
}

async function uploadPartWithRetry(session, file, partNumber, loadedByPart, getPartUrl) {
  const partSize = session.partSizeBytes;
  const start = (partNumber - 1) * partSize;
  const blob = file.slice(start, Math.min(file.size, start + partSize));
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const signedUrl = await getPartUrl(partNumber, { fresh: attempt > 1 });
      return await uploadPart(signedUrl, blob, partNumber, loadedByPart, file.size);
    } catch (error) {
      lastError = error;
      loadedByPart.set(partNumber, 0);
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
  }
  throw lastError || new Error(`Part ${partNumber} failed after retries.`);
}

async function uploadMultipartFile(session, file) {
  const partCount = Math.ceil(file.size / session.partSizeBytes);
  const loadedByPart = new Map();
  const parts = new Array(partCount);
  const getPartUrl = createPartUrlProvider(session, partCount);
  let nextPart = 1;

  async function workerLoop() {
    while (nextPart <= partCount) {
      const partNumber = nextPart;
      nextPart += 1;
      const uploaded = await uploadPartWithRetry(session, file, partNumber, loadedByPart, getPartUrl);
      parts[partNumber - 1] = uploaded;
    }
  }

  setStatus("Uploading Garmin ZIP...", 15);
  await Promise.all(Array.from({ length: Math.min(3, partCount) }, () => workerLoop()));
  setStatus("Completing upload...", 70);
  await apiFetch(`/api/uploads/${session.jobId}/complete`, {
    method: "POST",
    headers: { Authorization: `Bearer ${session.uploadToken}` },
    body: JSON.stringify({ size: file.size, parts }),
  });
}

async function abortUpload(session) {
  if (!session?.jobId || !session?.uploadToken) return;
  await apiFetch(`/api/uploads/${session.jobId}/abort`, {
    method: "POST",
    headers: { Authorization: `Bearer ${session.uploadToken}` },
    body: "{}",
  }).catch(() => {});
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
  submitButton.textContent = localMode ? "Preview locally" : "Start upload";
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
  if (!localMode && !checklistReady()) {
    setStatus("Complete the readiness checklist before uploading.", 0);
    return;
  }
  if (fileError) {
    setStatus(fileError, 0);
    return;
  }
  if (!localMode && turnstileRequired && !turnstileToken.value) {
    setStatus("Complete the browser check before uploading.", 0);
    return;
  }

  submitting = true;
  updateSubmitAvailability();
  submitButton.textContent = localMode ? "Processing..." : "Uploading...";
  setStatus(localMode ? "Starting local processor..." : "Reserving your slug...", 8);

  let session = null;
  try {
    if (localMode) {
      await processLocally(file);
      submitting = false;
      submitButton.textContent = "Preview locally";
      updateSubmitAvailability();
      return;
    }
    session = await apiFetch("/api/upload-sessions", {
      method: "POST",
      body: JSON.stringify({
        inviteCode: form.inviteCode.value,
        slug: form.slug.value,
        displayName: form.displayName.value,
        turnstileToken: turnstileToken.value,
        fileSize: file.size,
      }),
    });
    await uploadMultipartFile(session, file);
    setStatus("Upload complete. Processing is queued...", 72);
    await pollJob(session.jobId);
  } catch (error) {
    await abortUpload(session);
    resetLocalWorker();
    if (!localMode) resetTurnstile();
    handleError(error);
  }
});

localModeButton.addEventListener("click", () => setMode("local"));
uploadModeButton.addEventListener("click", () => setMode("upload"));
cancelLocalButton.addEventListener("click", () => {
  localWorker?.postMessage({ type: "cancel" });
  resetLocalWorker();
  handleError(new DOMException("Processing was canceled.", "AbortError"));
});
clearPreviewButton.addEventListener("click", () => {
  clearPreview();
  setStatus("Waiting for a Garmin ZIP for local preview.", 0);
});

window.addEventListener("message", (event) => {
  if (event.source !== localPreviewFrame.contentWindow || event.data?.type !== "runmaps-viewer-ready") return;
  if (!localPreviewData) return;
  const pointsBuffer = localPreviewData.points.buffer.slice(
    localPreviewData.points.byteOffset,
    localPreviewData.points.byteOffset + localPreviewData.points.byteLength
  );
  localPreviewFrame.contentWindow.postMessage(
    {
      type: "runmaps-local-data",
      meta: localPreviewData.meta,
      points: pointsBuffer,
    },
    window.location.origin,
    [pointsBuffer]
  );
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
setMode("local");
