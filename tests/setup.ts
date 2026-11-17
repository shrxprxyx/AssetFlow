import { vi, beforeAll, beforeEach } from "vitest";
import { resetRateLimitsForTests } from "@/lib/rateLimit";

// Replace NextAuth: tests choose who is "signed in" with signInAs()/signOut().
vi.mock("@/auth", () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

// Safety net: never let a test run against the dev database.
beforeAll(() => {
  const url = process.env.DATABASE_URL ?? "";
  if (!/_test\b/.test(url)) {
    throw new Error(`Refusing to run tests: DATABASE_URL "${url}" is not a *_test database.`);
  }
});

// Every test starts with empty rate-limit counters.
beforeEach(() => resetRateLimitsForTests());
