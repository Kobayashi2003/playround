import js from "@eslint/js";
import globals from "globals";
import prettier from "eslint-config-prettier";

export default [
  {
    ignores: [
      "node_modules/**",
      ".venv/**",
      "**/.wrangler/**",
      "dist/**",
      "cloud/dist/**",
      "firmware/**",
      "cloud/src/generated-assets.js",
    ],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser, ...globals.node, ...globals.worker },
    },
  },
  prettier,
];
