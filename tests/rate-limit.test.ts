import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  rateLimit,
  resetRateLimit,
  clientIp,
  tooManyRequests,
  type RateLimitRule,
} from "@/lib/rateLimit";
import { consumeLoginAttempt, clearLoginFailures, LOGIN_EMAIL_RULE } from "@/lib/loginLimit";

const rule: RateLimitRule = { name: "test", limit: 3, windowSec: 60 };

describe("rateLimit (fixed window)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("allows requests up to the limit and reports what is left", async () => {
    const a = await rateLimit(rule, "k");
    const b = await rateLimit(rule, "k");
    const c = await rateLimit(rule, "k");
    expect([a.allowed, b.allowed, c.allowed]).toEqual([true, true, true]);
    expect([a.remaining, b.remaining, c.remaining]).toEqual([2, 1, 0]);
  });

  it("blocks the request after the limit and says how long to wait", async () => {
    for (let i = 0; i < 3; i++) await rateLimit(rule, "k");
    vi.advanceTimersByTime(20_000);

    const blocked = await rateLimit(rule, "k");

    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSec).toBe(40);
  });

  it("lets requests through again once the window has passed", async () => {
    for (let i = 0; i < 4; i++) await rateLimit(rule, "k");
    vi.advanceTimersByTime(60_001);

    expect((await rateLimit(rule, "k")).allowed).toBe(true);
  });

  it("counts each identifier separately", async () => {
    for (let i = 0; i < 4; i++) await rateLimit(rule, "alice");

    expect((await rateLimit(rule, "alice")).allowed).toBe(false);
    expect((await rateLimit(rule, "bob")).allowed).toBe(true);
  });

  it("counts each rule separately for the same identifier", async () => {
    for (let i = 0; i < 4; i++) await rateLimit(rule, "k");

    expect((await rateLimit({ ...rule, name: "other" }, "k")).allowed).toBe(true);
  });

  it("resetRateLimit clears the counter", async () => {
    for (let i = 0; i < 4; i++) await rateLimit(rule, "k");
    await resetRateLimit(rule, "k");

    expect((await rateLimit(rule, "k")).allowed).toBe(true);
  });
});

describe("RATE_LIMIT_DISABLED (load tests only)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("lets everything through when set to true", async () => {
    vi.stubEnv("RATE_LIMIT_DISABLED", "true");

    for (let i = 0; i < 20; i++) expect((await rateLimit(rule, "flood")).allowed).toBe(true);
  });

  it("does nothing for any other value, so a stray setting can't switch limits off", async () => {
    vi.stubEnv("RATE_LIMIT_DISABLED", "1");

    for (let i = 0; i < 3; i++) await rateLimit(rule, "strict");

    expect((await rateLimit(rule, "strict")).allowed).toBe(false);
  });
});

describe("tooManyRequests", () => {
  it("is a 429 with Retry-After and a JSON body", async () => {
    const res = tooManyRequests({ allowed: false, limit: 3, remaining: 0, retryAfterSec: 42 });

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    const body = await res.json();
    expect(body.error).toBe("rate_limited");
    expect(body.retryAfterSec).toBe(42);
  });
});

describe("clientIp", () => {
  const req = (headers: Record<string, string>) => new NextRequest("http://localhost/x", { headers });

  it("uses the first address in X-Forwarded-For", () => {
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe("203.0.113.7");
  });

  it("falls back to X-Real-IP", () => {
    expect(clientIp(req({ "x-real-ip": "198.51.100.4" }))).toBe("198.51.100.4");
  });

  it("is 'unknown' when there is no proxy header", () => {
    expect(clientIp(req({}))).toBe("unknown");
  });
});

describe("login attempts", () => {
  it("blocks an account after too many attempts, whatever the case of the email", async () => {
    for (let i = 0; i < LOGIN_EMAIL_RULE.limit; i++) {
      expect((await consumeLoginAttempt("Priya@Example.com ", "1.1.1.1")).allowed).toBe(true);
    }

    expect((await consumeLoginAttempt("priya@example.com", "2.2.2.2")).allowed).toBe(false);
  });

  it("a successful sign-in gives the account its attempts back", async () => {
    for (let i = 0; i < LOGIN_EMAIL_RULE.limit - 1; i++) await consumeLoginAttempt("a@x.com", "1.1.1.1");
    await clearLoginFailures("a@x.com");

    for (let i = 0; i < LOGIN_EMAIL_RULE.limit; i++) {
      expect((await consumeLoginAttempt("a@x.com", "1.1.1.1")).allowed).toBe(true);
    }
  });

  it("one address trying many accounts is stopped by the per-address limit", async () => {
    let last = { allowed: true };
    for (let i = 0; i < 40; i++) last = await consumeLoginAttempt(`user${i}@x.com`, "9.9.9.9");

    expect(last.allowed).toBe(false);
    expect((await consumeLoginAttempt("fresh@x.com", "8.8.8.8")).allowed).toBe(true);
  });
});
