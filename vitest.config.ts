import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@cletus/ai": `${root}packages/ai/src/index.ts`,
      "@cletus/agent": `${root}packages/agent/src/index.ts`,
      "@cletus/tui": `${root}packages/tui/src/index.ts`,
      "@cletus/coding-agent": `${root}packages/coding-agent/src/index.ts`,
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
    testTimeout: 15000,
    pool: "forks",
  },
});