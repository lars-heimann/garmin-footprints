import { buildVisualizationFromGarminFile, messageForProcessorError } from "./processor-core.js";

let controller = null;

self.addEventListener("message", async (event) => {
  const { type, file, options } = event.data || {};
  if (type === "cancel") {
    controller?.abort();
    return;
  }
  if (type !== "process") return;

  controller = new AbortController();
  try {
    const result = await buildVisualizationFromGarminFile(file, {
      ...options,
      signal: controller.signal,
      onProgress(progress) {
        self.postMessage({ type: "progress", progress });
      },
    });
    self.postMessage(
      {
        type: "complete",
        meta: result.meta,
        points: result.points,
      },
      [result.points.buffer]
    );
  } catch (error) {
    self.postMessage({
      type: "error",
      code: error?.code || error?.name || "PROCESSING_FAILED",
      message: messageForProcessorError(error),
    });
  } finally {
    controller = null;
  }
});
