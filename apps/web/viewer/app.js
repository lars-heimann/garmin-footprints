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

const canvas = mustElement("scene", HTMLCanvasElement);
const errorBox = mustElement("error", HTMLParagraphElement);
const mapTitleEl = mustElement("mapTitle", HTMLHeadingElement);
const aboutMapEl = mustElement("aboutMap", HTMLParagraphElement);
const pointCountEl = mustElement("pointCount", HTMLElement);
const runCountEl = mustElement("runCount", HTMLElement);
const dateRangeEl = mustElement("dateRange", HTMLElement);
const currentDateEl = mustElement("currentDate", HTMLParagraphElement);
const meterFill = mustElement("meterFill", HTMLSpanElement);
const playPause = mustElement("playPause", HTMLButtonElement);
const replay = mustElement("replay", HTMLButtonElement);
const resetView = mustElement("resetView", HTMLButtonElement);
const shareMap = mustElement("shareMap", HTMLButtonElement);
const sharePrompt = mustElement("sharePrompt", HTMLElement);
const sharePromptButton = mustElement("sharePromptButton", HTMLButtonElement);
const closeSharePrompt = mustElement("closeSharePrompt", HTMLButtonElement);
const shareFeedback = mustElement("shareFeedback", HTMLParagraphElement);
const timeSlider = mustElement("timeSlider", HTMLInputElement);

const state = {
  gl: null,
  program: null,
  buffer: null,
  meta: null,
  points: null,
  progress: 0,
  playing: true,
  zoom: 1,
  pan: [0, 0],
  dragging: false,
  lastPointer: [0, 0],
  activePointers: new Map(),
  pinchDistance: null,
  lastFrame: performance.now(),
  needsRender: true,
};

function isPublicViewer() {
  return window.parent === window && !state.meta?.localOnly;
}

function shareUrl() {
  return state.meta?.siteUrl || window.location.href;
}

const vertexShaderSource = `
  attribute vec2 a_position;
  attribute float a_time;

  uniform float u_progress;
  uniform float u_zoom;
  uniform vec2 u_pan;
  uniform float u_aspect;
  uniform float u_point_size;

  varying float v_alpha;

  void main() {
    if (a_time > u_progress) {
      gl_Position = vec4(3.0, 3.0, 0.0, 1.0);
      gl_PointSize = 0.0;
      v_alpha = 0.0;
      return;
    }

    vec2 p = (a_position + u_pan) * u_zoom;
    if (u_aspect > 1.0) {
      p.x /= u_aspect;
    } else {
      p.y *= u_aspect;
    }

    gl_Position = vec4(p, 0.0, 1.0);
    gl_PointSize = u_point_size;
    float settled = smoothstep(0.0, 0.08, u_progress - a_time);
    v_alpha = mix(0.028, 0.07, settled);
  }
`;

const fragmentShaderSource = `
  precision mediump float;
  varying float v_alpha;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    float soft = smoothstep(0.5, 0.05, d);
    vec3 cool = vec3(0.30, 0.90, 0.84);
    vec3 warm = vec3(1.0, 0.68, 0.26);
    vec3 color = mix(cool, warm, soft * 0.35);
    gl_FragColor = vec4(color * soft, v_alpha * soft);
  }
`;

function showError(message) {
  errorBox.hidden = false;
  errorBox.textContent = message;
}

function showShareFeedback(message) {
  shareFeedback.textContent = message;
  shareFeedback.hidden = false;
}

async function copyShareUrl(url) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(url);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = url;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  document.body.append(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

async function shareCurrentMap() {
  const url = shareUrl();
  const title = state.meta?.viewerTitle || document.title || "Running Footprints";
  try {
    if (navigator.share) {
      await navigator.share({ title, text: "My running footprints map", url });
      showShareFeedback("Share menu opened.");
      return;
    }
    await copyShareUrl(url);
    showShareFeedback("Link copied.");
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    try {
      await copyShareUrl(url);
      showShareFeedback("Link copied.");
    } catch {
      showShareFeedback("Could not copy the link. Use the address bar instead.");
    }
  }
}

function maybeShowSharePrompt() {
  if (!isPublicViewer()) return;
  shareMap.hidden = false;
  const key = `runmaps-share-prompt:${shareUrl()}`;
  try {
    if (sessionStorage.getItem(key)) return;
  } catch {
    // Some embedded or strict privacy contexts block session storage.
  }
  sharePrompt.hidden = false;
  try {
    sessionStorage.setItem(key, "shown");
  } catch {
    // The prompt can still be dismissed manually.
  }
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) || "Shader compilation failed.");
  }
  return shader;
}

function createProgram(gl) {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || "Program link failed.");
  }
  return program;
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(value);
}

function formatMonth(date) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    year: "numeric",
  }).format(date);
}

function formatDay(date) {
  return new Intl.DateTimeFormat(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

function totalRuns() {
  return state.meta.parsedRunActivities || state.meta.runCount || 0;
}

function currentDateFromProgress() {
  const start = new Date(state.meta.start).getTime();
  const end = new Date(state.meta.end).getTime();
  return new Date(start + (end - start) * state.progress);
}

function countVisiblePoints() {
  if (state.progress <= 0) return 0;
  if (state.progress >= 1) return state.meta.pointCount;

  let low = 0;
  let high = state.meta.pointCount;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (state.points[mid * 3 + 2] <= state.progress) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

function countVisibleRuns() {
  const runTotal = totalRuns();
  const runProgress = state.meta.runProgress;
  if (state.progress <= 0) return 0;
  if (state.progress >= 1) return runTotal;
  if (!Array.isArray(runProgress)) {
    return Math.min(runTotal, Math.floor(runTotal * state.progress));
  }

  let low = 0;
  let high = runProgress.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (runProgress[mid] <= state.progress) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

function updateHud() {
  const progressPercent = Math.round(state.progress * 1000) / 10;
  pointCountEl.textContent = `${formatNumber(countVisiblePoints())} / ${formatNumber(state.meta.pointCount)}`;
  runCountEl.textContent = `${formatNumber(countVisibleRuns())} / ${formatNumber(totalRuns())}`;
  currentDateEl.textContent = `${formatDay(currentDateFromProgress())} - ${progressPercent.toFixed(1)}%`;
  meterFill.style.width = `${state.progress * 100}%`;
  timeSlider.value = String(Math.round(state.progress * 1000));
}

function resize() {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.floor(canvas.clientWidth * ratio));
  const height = Math.max(1, Math.floor(canvas.clientHeight * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    state.needsRender = true;
  }
}

function render() {
  const gl = state.gl;
  resize();

  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0.015, 0.022, 0.024, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(state.program);

  const aspect = canvas.width / canvas.height;
  const pointSize = Math.max(1.15, Math.min(2.8, 1.55 * Math.sqrt(state.zoom)));

  gl.uniform1f(gl.getUniformLocation(state.program, "u_progress"), state.progress);
  gl.uniform1f(gl.getUniformLocation(state.program, "u_zoom"), state.zoom);
  gl.uniform2f(gl.getUniformLocation(state.program, "u_pan"), state.pan[0], state.pan[1]);
  gl.uniform1f(gl.getUniformLocation(state.program, "u_aspect"), aspect);
  gl.uniform1f(gl.getUniformLocation(state.program, "u_point_size"), pointSize);

  gl.drawArrays(gl.POINTS, 0, state.meta.pointCount);
  updateHud();
  state.needsRender = false;
}

function frame(now) {
  const elapsed = now - state.lastFrame;
  state.lastFrame = now;

  if (state.playing) {
    state.progress = Math.min(1, state.progress + elapsed / 18000);
    if (state.progress >= 1) {
      state.playing = false;
      playPause.textContent = "Play";
    }
    state.needsRender = true;
  }

  if (state.needsRender) {
    render();
  }
  requestAnimationFrame(frame);
}

function resetCamera() {
  state.zoom = 1;
  state.pan = [0, 0];
  state.needsRender = true;
}

function pointerDistance(pointerA, pointerB) {
  return Math.hypot(pointerA.clientX - pointerB.clientX, pointerA.clientY - pointerB.clientY);
}

function updateSinglePointerDrag(event) {
  const dx = event.clientX - state.lastPointer[0];
  const dy = event.clientY - state.lastPointer[1];
  const aspect = canvas.width / canvas.height;
  const xScale = aspect > 1 ? aspect : 1;
  const yScale = aspect < 1 ? 1 / aspect : 1;
  state.pan[0] += ((dx / canvas.clientWidth) * 2 * xScale) / state.zoom;
  state.pan[1] -= ((dy / canvas.clientHeight) * 2 * yScale) / state.zoom;
  state.lastPointer = [event.clientX, event.clientY];
  state.needsRender = true;
}

function updatePinchZoom() {
  if (state.activePointers.size !== 2) return;
  const pointers = [...state.activePointers.values()];
  const distance = pointerDistance(pointers[0], pointers[1]);
  if (!state.pinchDistance) {
    state.pinchDistance = distance;
    return;
  }
  const delta = distance / state.pinchDistance;
  state.zoom = Math.max(0.6, Math.min(120, state.zoom * delta));
  state.pinchDistance = distance;
  state.needsRender = true;
}

function capturePointer(event) {
  try {
    canvas.setPointerCapture(event.pointerId);
  } catch {
    // Synthetic events in some tests do not expose pointer capture.
  }
}

function endPointer(event) {
  state.activePointers.delete(event.pointerId);
  state.pinchDistance = null;
  state.dragging = state.activePointers.size === 1;

  if (state.dragging) {
    const [remainingPointer] = state.activePointers.values();
    state.lastPointer = [remainingPointer.clientX, remainingPointer.clientY];
  }

  if (canvas.hasPointerCapture(event.pointerId)) {
    try {
      canvas.releasePointerCapture(event.pointerId);
    } catch {
      // Ignore stale capture state from canceled or synthetic pointers.
    }
  }
}

function bindControls() {
  playPause.addEventListener("click", () => {
    state.playing = !state.playing;
    playPause.textContent = state.playing ? "Pause" : "Play";
    state.lastFrame = performance.now();
    state.needsRender = true;
  });

  replay.addEventListener("click", () => {
    state.progress = 0;
    state.playing = true;
    playPause.textContent = "Pause";
    state.lastFrame = performance.now();
    state.needsRender = true;
  });

  resetView.addEventListener("click", resetCamera);
  shareMap.addEventListener("click", shareCurrentMap);
  sharePromptButton.addEventListener("click", shareCurrentMap);
  closeSharePrompt.addEventListener("click", () => {
    sharePrompt.hidden = true;
  });

  timeSlider.addEventListener("input", () => {
    state.progress = Number(timeSlider.value) / 1000;
    state.playing = false;
    playPause.textContent = "Play";
    state.needsRender = true;
  });

  canvas.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    state.activePointers.set(event.pointerId, event);
    state.dragging = state.activePointers.size === 1;
    state.lastPointer = [event.clientX, event.clientY];
    state.pinchDistance = null;
    capturePointer(event);
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!state.activePointers.has(event.pointerId)) return;
    event.preventDefault();
    state.activePointers.set(event.pointerId, event);

    if (state.activePointers.size === 2) {
      state.dragging = false;
      updatePinchZoom();
      return;
    }

    if (state.dragging) {
      updateSinglePointerDrag(event);
    }
  });

  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);

  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const delta = Math.exp(-event.deltaY * 0.0012);
      state.zoom = Math.max(0.6, Math.min(120, state.zoom * delta));
      state.needsRender = true;
    },
    { passive: false }
  );

  window.addEventListener("resize", () => {
    state.needsRender = true;
  });
}

async function loadData() {
  if (window.parent && window.parent !== window) {
    const localData = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Local preview data was not received.")), 30000);
      window.addEventListener(
        "message",
        (event) => {
          if (event.data?.type !== "runmaps-local-data") return;
          clearTimeout(timeout);
          resolve(event.data);
        },
        { once: true }
      );
      window.parent.postMessage({ type: "runmaps-viewer-ready" }, window.location.origin);
    });
    state.meta = localData.meta;
    state.points = new Float32Array(localData.points);
    if (state.points.length !== state.meta.pointCount * 3) {
      throw new Error("Point binary size does not match metadata.");
    }
    return;
  }

  const [metaResponse, pointsResponse] = await Promise.all([fetch("./meta.json"), fetch("./points.bin")]);
  if (!metaResponse.ok || !pointsResponse.ok) {
    throw new Error("Could not load generated visualization data.");
  }
  state.meta = await metaResponse.json();
  const buffer = await pointsResponse.arrayBuffer();
  state.points = new Float32Array(buffer);
  if (state.points.length !== state.meta.pointCount * 3) {
    throw new Error("Point binary size does not match metadata.");
  }
}

function applyMetadata() {
  const title = state.meta.viewerTitle || "Running Footprints";
  document.title = title;
  mapTitleEl.textContent = title;
  if (state.meta.displayName) {
    const name = state.meta.displayName;
    aboutMapEl.textContent = `${name}${String(name).toLowerCase().endsWith("s") ? "'" : "'s"} running routes from a Garmin account export. Brighter streets were run more often.`;
  }
  dateRangeEl.textContent = `${formatMonth(new Date(state.meta.start))} - ${formatMonth(new Date(state.meta.end))}`;
}

function initializeGl() {
  const gl = canvas.getContext("webgl", {
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: true,
  });
  if (!gl) {
    throw new Error("WebGL is not available in this browser.");
  }
  state.gl = gl;
  state.program = createProgram(gl);
  state.buffer = gl.createBuffer();

  gl.bindBuffer(gl.ARRAY_BUFFER, state.buffer);
  gl.bufferData(gl.ARRAY_BUFFER, state.points, gl.STATIC_DRAW);

  const positionLocation = gl.getAttribLocation(state.program, "a_position");
  const timeLocation = gl.getAttribLocation(state.program, "a_time");
  gl.enableVertexAttribArray(positionLocation);
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 12, 0);
  gl.enableVertexAttribArray(timeLocation);
  gl.vertexAttribPointer(timeLocation, 1, gl.FLOAT, false, 12, 8);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE);
}

async function main() {
  try {
    await loadData();
    applyMetadata();
    maybeShowSharePrompt();
    initializeGl();
    bindControls();
    requestAnimationFrame(frame);
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  }
}

main();
