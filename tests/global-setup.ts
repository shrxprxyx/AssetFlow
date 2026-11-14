import { execSync } from "node:child_process";

// Runs once before all tests: apply every migration (including the raw-SQL
// partial unique index and booking exclusion constraint) to the TEST database.
export default function setup() {
  const url =
    process.env.TEST_DATABASE_URL ??
    "postgresql://assetflow:assetflow@localhost:5433/assetflow_test?schema=public";

  if (!/_test\b/.test(url)) {
    throw new Error(`Refusing to run tests: "${url}" is not a *_test database.`);
  }

  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
  });
}