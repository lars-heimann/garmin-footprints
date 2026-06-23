const form = document.getElementById("uploadForm");
const fileInput = document.getElementById("zipFile");
const fileLabel = document.getElementById("fileLabel");
const submitButton = document.getElementById("submitButton");
const statusText = document.getElementById("statusText");
const meterFill = document.getElementById("meterFill");
const shareLink = document.getElementById("shareLink");

let activePoll = null;

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
    throw new Error(payload.errorMessage || payload.errorCode || `Request failed with ${response.status}`);
  }
  return payload;
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
        message = payload.errorMessage || payload.errorCode || message;
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
    submitButton.disabled = false;
    submitButton.textContent = "Start upload";
    return;
  }
  if (job.status === "failed") {
    throw new Error(job.errorMessage || "Processing failed.");
  }
  const statusLabel = job.status === "processing" ? "Processing running GPS data..." : "Waiting for processing...";
  setStatus(statusLabel, job.status === "processing" ? 82 : 72);
  activePoll = setTimeout(() => pollJob(jobId).catch(handleError), 2500);
}

function handleError(error) {
  setStatus(error instanceof Error ? error.message : String(error), 0);
  submitButton.disabled = false;
  submitButton.textContent = "Start upload";
}

fileInput.addEventListener("change", () => {
  const [file] = fileInput.files;
  fileLabel.textContent = file ? file.name : "Choose Garmin ZIP";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  shareLink.hidden = true;
  const [file] = fileInput.files;
  if (!file) {
    setStatus("Choose a Garmin ZIP first.", 0);
    return;
  }
  if (!file.name.toLowerCase().endsWith(".zip")) {
    setStatus("Upload the Garmin export ZIP unchanged.", 0);
    return;
  }

  submitButton.disabled = true;
  submitButton.textContent = "Uploading...";
  setStatus("Reserving your slug...", 8);

  try {
    const session = await apiFetch("/api/upload-sessions", {
      method: "POST",
      body: JSON.stringify({
        inviteCode: form.inviteCode.value,
        slug: form.slug.value,
        displayName: form.displayName.value,
      }),
    });
    await uploadFile(session.uploadUrl, file);
    setStatus("Upload complete. Processing is queued...", 72);
    await pollJob(session.jobId);
  } catch (error) {
    handleError(error);
  }
});
