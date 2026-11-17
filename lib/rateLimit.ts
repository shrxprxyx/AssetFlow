import { NextResponse } from "next/server";
import IORedis from "ioredis";
import { redisUrl } from "@/lib/queue";

/**
 * Fixed-window rate limiting.
 *
 *   const r = await rateLimit(LIMITS.signup, clientIp(req));
 *   if (!r.allowed) return tooManyRequests(r);
 *
 * Counters live in Redis, so the limit holds across every web instance. If
 * Redis is down the counters fall back to this process's memory (limits then
 * apply per instance) instead of failing the request: an outage must not lock
 * everyone out of the app. Tests and QUEUE_MODE=inline use memory only.
 */

export type RateLimitRule = {
  /** Namespace for the counter, e.g. "signup". */
  name: string;
  /** Requests allowed per window. */
  limit: number;
  windowSec: number;
};

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the window ends and the counter starts again. */
  retryAfterSec: number;
};

/** Every limit in one place. */
export const LIMITS = {
  /** Sign-in attempts per account (see lib/loginLimit.ts). */
  loginEmail: { name: "login-email", limit: 10, windowSec: 15 * 60 },
  /** Sign-in attempts per address, across all accounts. */
  loginIp: { name: "login-ip", limit: 30, windowSec: 15 * 60 },
  signup: { name: "signup", limit: 10, windowSec: 60 * 60 },
  forgotPassword: { name: "forgot-password", limit: 10, windowSec: 60 * 60 },
  resetPassword: { name: "reset-password", limit: 20, windowSec: 60 * 60 },
  /** Any POST/PUT/PATCH/DELETE by a signed-in user. */
  writes: { name: "writes", limit: 120, windowSec: 60 },
} satisfies Record<string, RateLimitRule>;

/* ─────────────────────────────── memory store ─────────────────────────────── */

type Counter = { count: number; resetAt: number };
const memory = new Map<string, Counter>();
const MAX_MEMORY_KEYS = 10_000;

function hitMemory(key: string, windowMs: number) {
  const now = Date.now();

  if (memory.size > MAX_MEMORY_KEYS) {
    for (const [k, c] of memory) if (c.resetAt <= now) memory.delete(k);
  }

  let entry = memory.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + windowMs };
    memory.set(key, entry);
  }
  entry.count += 1;
  return { count: entry.count, ttlMs: entry.resetAt - now };
}

/** For tests: forget every counter. */
export function resetRateLimitsForTests() {
  memory.clear();
}

/* ──────────────────────────────── redis store ─────────────────────────────── */

// INCR and the expiry happen in one step, so a crash between them can never
// leave a counter that never expires.
const HIT_SCRIPT = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local t = redis.call('PTTL', KEYS[1])
if t < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); t = tonumber(ARGV[1]) end
return {c, t}
`;

const RETRY_REDIS_AFTER_MS = 10_000;
let redisDownUntil = 0;
const g = globalThis as unknown as { __rateLimitRedis?: IORedis };

const redisEnabled = () => process.env.QUEUE_MODE !== "inline" && process.env.RATE_LIMIT_STORE !== "memory";

function redis() {
  if (!g.__rateLimitRedis) {
    // Fail fast: a request must never wait on a dead Redis.
    g.__rateLimitRedis = new IORedis(redisUrl(), {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 1_000,
    });
    g.__rateLimitRedis.on("error", () => {
      /* handled where it is used: we fall back to memory */
    });
  }
  return g.__rateLimitRedis;
}

function markRedisDown(err: unknown) {
  redisDownUntil = Date.now() + RETRY_REDIS_AFTER_MS;
  console.warn("[rateLimit] Redis unavailable, counting in memory for 10s:", (err as Error)?.message);
}

async function hit(key: string, windowMs: number): Promise<{ count: number; ttlMs: number }> {
  if (redisEnabled() && Date.now() >= redisDownUntil) {
    try {
      const [count, ttlMs] = (await redis().eval(HIT_SCRIPT, 1, key, String(windowMs))) as [number, number];
      return { count, ttlMs };
    } catch (err) {
      markRedisDown(err);
    }
  }
  return hitMemory(key, windowMs);
}

const keyFor = (rule: RateLimitRule, id: string) => `rl:${rule.name}:${id}`;

/* ──────────────────────────────────── API ─────────────────────────────────── */

let warnedDisabled = false;

/**
 * Load tests send thousands of requests from one machine, which the limits
 * would (rightly) block. Setting RATE_LIMIT_DISABLED=true switches them off for
 * that run. Only the exact value "true" counts. Never set it on a real server.
 */
function limitsDisabled() {
  if (process.env.RATE_LIMIT_DISABLED !== "true") return false;
  if (!warnedDisabled) {
    warnedDisabled = true;
    console.warn("[rateLimit] RATE_LIMIT_DISABLED=true: rate limiting is OFF. Use this for load tests only.");
  }
  return true;
}

/** Counts this request and says whether it is within the limit. */
export async function rateLimit(rule: RateLimitRule, identifier: string): Promise<RateLimitResult> {
  if (limitsDisabled()) {
    return { allowed: true, limit: rule.limit, remaining: rule.limit, retryAfterSec: 1 };
  }
  const { count, ttlMs } = await hit(keyFor(rule, identifier), rule.windowSec * 1000);
  return {
    allowed: count <= rule.limit,
    limit: rule.limit,
    remaining: Math.max(0, rule.limit - count),
    retryAfterSec: Math.max(1, Math.ceil(ttlMs / 1000)),
  };
}

/** Forget the counter, e.g. after a successful sign-in. */
export async function resetRateLimit(rule: RateLimitRule, identifier: string): Promise<void> {
  const key = keyFor(rule, identifier);
  memory.delete(key);
  if (redisEnabled() && Date.now() >= redisDownUntil) {
    try {
      await redis().del(key);
    } catch (err) {
      markRedisDown(err);
    }
  }
}

export function tooManyRequests(result: RateLimitResult, message = "Too many requests. Please try again later.") {
  return NextResponse.json(
    { error: "rate_limited", message, retryAfterSec: result.retryAfterSec },
    { status: 429, headers: { "Retry-After": String(result.retryAfterSec) } }
  );
}

/**
 * The caller's address, from the proxy header. Run the app behind a proxy that
 * sets X-Forwarded-For (any host or load balancer does). The address alone is
 * not trusted for anything important: logins are also limited per account.
 */
export function clientIp(req: { headers: Headers }): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || req.headers.get("x-real-ip")?.trim() || "unknown";
}
