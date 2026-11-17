import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST as signup } from "@/app/api/auth/signup/route";
import { POST as forgotPassword } from "@/app/api/auth/forgot-password/route";
import { POST as resetPassword } from "@/app/api/auth/reset-password/route";
import { POST as createAsset } from "@/app/api/assets/route";
import { GET as listAssets } from "@/app/api/assets/route";
import { resetDb, createUser } from "./helpers/db";
import { signInAs } from "./helpers/auth";
import { LIMITS } from "@/lib/rateLimit";

function post(url: string, body: unknown, ip = "203.0.113.1") {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

describe("rate limits on the routes", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("signup: the attempt after the limit is a 429 with Retry-After", async () => {
    // Invalid bodies are still counted: the limit is on attempts, not successes.
    for (let i = 0; i < LIMITS.signup.limit; i++) {
      expect((await signup(post("/api/auth/signup", {}))).status).toBe(400);
    }

    const res = await signup(post("/api/auth/signup", {}));

    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("signup: another address is not affected", async () => {
    for (let i = 0; i <= LIMITS.signup.limit; i++) await signup(post("/api/auth/signup", {}, "198.51.100.1"));

    const res = await signup(post("/api/auth/signup", {}, "198.51.100.2"));

    expect(res.status).toBe(400);
  });

  it("forgot-password: 429 after the limit", async () => {
    for (let i = 0; i < LIMITS.forgotPassword.limit; i++) {
      expect((await forgotPassword(post("/api/auth/forgot-password", { email: "nobody@x.com" }))).status).toBe(200);
    }

    const res = await forgotPassword(post("/api/auth/forgot-password", { email: "nobody@x.com" }));

    expect(res.status).toBe(429);
  });

  it("reset-password: 429 after the limit", async () => {
    for (let i = 0; i < LIMITS.resetPassword.limit; i++) {
      await resetPassword(post("/api/auth/reset-password", { token: "x".repeat(40), password: "Newpassw0rd!" }));
    }

    const res = await resetPassword(post("/api/auth/reset-password", { token: "x".repeat(40), password: "Newpassw0rd!" }));

    expect(res.status).toBe(429);
  });

  it("writes: a signed-in user is limited per minute, and the limit is theirs alone", async () => {
    const busy = await createUser({ role: "ADMIN" });
    const other = await createUser({ role: "ADMIN" });

    signInAs(busy);
    for (let i = 0; i < LIMITS.writes.limit; i++) {
      // A bad body: it is rejected (400), but still counts as a write.
      expect((await createAsset(post("/api/assets", {}))).status).toBe(400);
    }
    const blocked = await createAsset(post("/api/assets", {}));
    expect(blocked.status).toBe(429);

    signInAs(other);
    expect((await createAsset(post("/api/assets", {}))).status).toBe(400);
  });

  it("reads are never limited by the write limit", async () => {
    const admin = await createUser({ role: "ADMIN" });
    signInAs(admin);
    for (let i = 0; i <= LIMITS.writes.limit; i++) await createAsset(post("/api/assets", {}));

    const res = await listAssets(new NextRequest("http://localhost/api/assets"));

    expect(res.status).toBe(200);
  });
});
