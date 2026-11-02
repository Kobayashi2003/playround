import { defineConfig } from "vitest/config";

// Each test boots Miniflare, which outlasts Vitest's 5 s default.
export default defineConfig({
  test: {
    include: ["test/**/*.test.mjs"],
    testTimeout: 30_000,
  },
});
