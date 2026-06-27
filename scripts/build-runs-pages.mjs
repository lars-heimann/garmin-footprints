import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const outputDir = join(root, "dist", "runs-pages");
const viewerDir = join(root, "apps", "web", "viewer");
const dataDir = join(root, "sites", "runs");
const requiredFiles = ["index.html", "app.js", "styles.css", "meta.json", "points.bin", ".nojekyll"];
const runsPageTitle = "Lars' Running Footprints";
const runsPageDescription =
  "Explore Lars Heimann's running routes as an interactive map, then try Lars' Garmin RunMaps yourself.";

async function copyArtifact() {
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  for (const file of ["index.html", "app.js", "styles.css"]) {
    await copyFile(join(viewerDir, file), join(outputDir, file));
  }
  for (const file of ["meta.json", "points.bin"]) {
    await copyFile(join(dataDir, file), join(outputDir, file));
  }
  await writeRunsPageMetadata();
  await writeFile(join(outputDir, ".nojekyll"), "");
}

async function writeRunsPageMetadata() {
  const indexPath = join(outputDir, "index.html");
  const html = await readFile(indexPath, "utf8");
  await writeFile(
    indexPath,
    html
      .replace(/<title>.*?<\/title>/, `<title>${runsPageTitle}</title>`)
      .replace(
        /<meta\s+name="description"\s+content="[^"]*"\s*\/>|<meta\s+name="description"[\s\S]*?\/>/,
        `<meta name="description" content="${runsPageDescription}" />`
      )
      .replace(
        /<meta\s+property="og:title"\s+content="[^"]*"\s*\/>/,
        `<meta property="og:title" content="${runsPageTitle}" />`
      )
      .replace(
        /<meta\s+property="og:description"\s+content="[^"]*"\s*\/>|<meta\s+property="og:description"[\s\S]*?\/>/,
        `<meta property="og:description" content="${runsPageDescription}" />`
      )
      .replace(
        /<meta\s+name="twitter:title"\s+content="[^"]*"\s*\/>/,
        `<meta name="twitter:title" content="${runsPageTitle}" />`
      )
      .replace(
        /<meta\s+name="twitter:description"\s+content="[^"]*"\s*\/>|<meta\s+name="twitter:description"[\s\S]*?\/>/,
        `<meta name="twitter:description" content="${runsPageDescription}" />`
      )
  );
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
  if (meta.viewerEyebrow !== "Lars' Running Footprints") {
    throw new Error("meta.json must set the personal Pages eyebrow");
  }
  if (meta.viewerHeadline !== "Every run, one GPS point at a time") {
    throw new Error("meta.json must set the personal Pages headline");
  }
  if (meta.ctaLabel !== "I want this too") {
    throw new Error("meta.json must set the Lars RunMaps CTA label");
  }
  if (meta.ctaHref !== "https://runmaps.larsheimann.com/") {
    throw new Error("meta.json must set the Lars RunMaps CTA URL");
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

  const html = await readFile(join(outputDir, "index.html"), "utf8");
  if (!html.includes(`<title>${runsPageTitle}</title>`)) {
    throw new Error("runs Pages artifact must set the Lars page title");
  }
  if (!html.includes(`content="${runsPageDescription}"`)) {
    throw new Error("runs Pages artifact must set the Lars page description");
  }
}

await copyArtifact();
await validateArtifact();
console.log(`Built runs Pages artifact at ${outputDir}`);
