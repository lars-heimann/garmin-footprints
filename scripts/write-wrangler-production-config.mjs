import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const [, , outputPath = "/tmp/runmaps-wrangler.jsonc"] = process.argv;
const root = resolve(new URL("..", import.meta.url).pathname);
const baseConfigPath = resolve(root, "apps/worker/wrangler.jsonc");

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

const config = parseJsonc(await readFile(baseConfigPath, "utf8"));
const publicHostSuffix = process.env.PUBLIC_HOST_SUFFIX || "runmaps.larsheimann.com";

config.r2_buckets = [
  {
    binding: "SITE_BUCKET",
    bucket_name: requiredEnv("R2_BUCKET_NAME"),
  },
];
config.d1_databases = [
  {
    binding: "DB",
    database_name: requiredEnv("D1_DATABASE_NAME"),
    database_id: requiredEnv("D1_DATABASE_ID"),
  },
];
config.vars = {
  ...config.vars,
  R2_ACCOUNT_ID: requiredEnv("CLOUDFLARE_ACCOUNT_ID"),
  R2_BUCKET_NAME: requiredEnv("R2_BUCKET_NAME"),
  PUBLIC_HOST_SUFFIX: publicHostSuffix,
  PUBLIC_SITE_URL_PATTERN: process.env.PUBLIC_SITE_URL_PATTERN || `https://${publicHostSuffix}/m/{slug}`,
};

if (process.env.TURNSTILE_SITE_KEY) {
  config.vars.TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY;
}

await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`);
console.log(outputPath);

function parseJsonc(input) {
  return JSON.parse(stripTrailingCommas(stripJsonComments(input)));
}

function stripJsonComments(input) {
  let output = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        output += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }

    output += char;
  }

  return output;
}

function stripTrailingCommas(input) {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === ",") {
      let lookahead = index + 1;
      while (/\s/.test(input[lookahead] || "")) {
        lookahead += 1;
      }
      if (input[lookahead] === "}" || input[lookahead] === "]") {
        continue;
      }
    }
    output += char;
  }

  return output;
}
