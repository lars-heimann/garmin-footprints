import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const outputDir = join(root, "dist", "runs-pages");
const viewerDir = join(root, "apps", "web", "viewer");
const dataDir = join(root, "sites", "runs");
const requiredFiles = ["index.html", "app.js", "styles.css", "meta.json", "points.bin", ".nojekyll"];

async function copyArtifact() {
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  for (const file of ["index.html", "app.js", "styles.css"]) {
    await copyFile(join(viewerDir, file), join(outputDir, file));
  }
  for (const file of ["meta.json", "points.bin"]) {
    await copyFile(join(dataDir, file), join(outputDir, file));
  }
  await writeFile(join(outputDir, ".nojekyll"), "");
}

async function assertFile(path) {
  const details = await stat(path);
  if (!details.isFile()) {
    throw new Error(`${path} is not a file`);
  }
  return details;
}

async function validateArtifact() {
  for (const file of requiredFiles) {
    await assertFile(join(outputDir, file));
  }

  try {
    await stat(join(outputDir, "CNAME"));
    throw new Error("runs Pages artifact must not claim a custom domain yet");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const meta = JSON.parse(await readFile(join(outputDir, "meta.json"), "utf8"));
  if (Object.hasOwn(meta, "sourceArchive")) {
    throw new Error("meta.json must not expose the source Garmin archive path");
  }
  if (meta.displayName !== "Lars") {
    throw new Error('meta.json must set displayName to "Lars"');
  }
  if (meta.viewerTitle !== "Lars' Running Footprints") {
    throw new Error("meta.json must set the Lars running-footprints title");
  }
  if (meta.localOnly !== false) {
    throw new Error("meta.json must mark the static Pages map as public");
  }
  if (meta.siteUrl !== null) {
    throw new Error("meta.json must keep siteUrl null until the custom domain cutover");
  }
  if (!Number.isInteger(meta.pointCount) || meta.pointCount <= 0) {
    throw new Error("meta.json pointCount must be a positive integer");
  }
  if (!Number.isInteger(meta.parsedRunActivities) || meta.parsedRunActivities <= 0) {
    throw new Error("meta.json parsedRunActivities must be a positive integer");
  }
  if (!Array.isArray(meta.runProgress) || meta.runProgress.length !== meta.parsedRunActivities) {
    throw new Error("meta.json runProgress must contain one entry per parsed run");
  }

  const points = await assertFile(join(outputDir, "points.bin"));
  const expectedBytes = meta.pointCount * 12;
  if (points.size !== expectedBytes) {
    throw new Error(`points.bin is ${points.size} bytes; expected ${expectedBytes}`);
  }
}

await copyArtifact();
await validateArtifact();
console.log(`Built runs Pages artifact at ${outputDir}`);
