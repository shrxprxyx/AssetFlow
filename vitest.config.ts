import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Tests run against a SEPARATE database so they can wipe tables freely.
// Create it once:  docker compose exec postgres psql -U assetflow -d postgres -c "CREATE DATABASE assetflow_test;"
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://assetflow:assetflow@localhost:5433/assetflow_test?schema=public";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    setupFiles: ["tests/setup.ts"],
    // One shared database: test files must not run at the same time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      DIRECT_URL: TEST_DATABASE_URL,
    },
  },
});