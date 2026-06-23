import js from "@eslint/js";
import globals from "globals";

const workerGlobals = {
  ...globals.serviceworker,
  atob: "readonly",
  btoa: "readonly",
  console: "readonly",
  crypto: "readonly",
  fetch: "readonly",
  FormData: "readonly",
  TextDecoder: "readonly",
  TextEncoder: "readonly",
};

export default [
  {
    ignores: [
      "node_modules/**",
      ".wrangler/**",
      "coverage/**",
      "infra/**/.terraform/**",
      "processor/**/__pycache__/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.{js,mjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      "no-console": "off",
    },
  },
  {
    files: ["apps/worker/src/**/*.js"],
    languageOptions: {
      globals: workerGlobals,
    },
  },
];
