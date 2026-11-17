import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";

// Capture outgoing email instead of sending it, so tests can read the reset link.
vi.mock("@/services/mailer", () => ({
  deliverEmail: vi.fn(async () => undefined),
  sendMail: vi.fn(async () => undefined),
}));

import { POST as forgotPassword } from "@/app/api/auth/forgot-password/route";
import { POST as resetPasswordRoute } from "@/app/api/auth/reset-password/route";
import { deliverEmail } from "@/services/mailer";
import { hashToken } from "@/services/passwordReset";
import { prisma } from "@/services/prisma";
import { resetDb } from "./helpers/db";
import { call } from "./helpers/http";

const MINUTE = 60_000;
const OLD_PASSWORD = "old-password-123";
const NEW_PASSWORD = "brand-new-password";
const GENERIC = "If an account exists for that email, a reset link has been sent.";

const forgot = (email: unknown) => call(forgotPassword, "POST", "/api/auth/forgot-password", { email });
const reset = (token: unknown, password: unknown) =>
  call(resetPasswordRoute, "POST", "/api/auth/reset-password", { token, password });

const mails = () => vi.mocked(deliverEmail).mock.calls.map(([mail]) => mail);

/** The token inside the link of the most recent email. */
function lastToken() {
  const last = mails().at(-1);
  if (!last) throw new Error("no email was sent");
  const match = /\/reset-password\?token=([\w-]+)/.exec(last.text);
  if (!match) throw new Error("the email has no reset link");
  return match[1];
}

async function createAccount(email = "priya@example.com", status: "ACTIVE" | "INACTIVE" = "ACTIVE") {
  return prisma.user.create({
    data: {
      email,
      passwordHash: await bcrypt.hash(OLD_PASSWORD, 4), // low cost: tests only
      firstName: "Priya",
      lastName: "Shah",
      status,
    },
  });
}

/** Pretend earlier requests were made a while ago, to get past the one-per-minute limit. */
const ageTokens = (minutes: number) =>
  prisma.passwordResetToken.updateMany({ data: { createdAt: new Date(Date.now() - minutes * MINUTE) } });

const passwordIs = async (userId: number, password: string) =>
  bcrypt.compare(password, (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).passwordHash);

beforeEach(async () => {
  await resetDb();
  vi.mocked(deliverEmail).mockClear();
});

describe("forgot password: asking for a link", () => {
  it("emails a reset link to a known address", async () => {
    const user = await createAccount();

    const res = await forgot("priya@example.com");

    expect(res.status).toBe(200);
    expect(res.body.message).toBe(GENERIC);
    expect(mails()).toHaveLength(1);
    expect(mails()[0].to).toBe(user.email);
    expect(mails()[0].text).toContain("/reset-password?token=");
  });

  it("stores only a hash of the token, never the token itself", async () => {
    await createAccount();
    await forgot("priya@example.com");

    const token = lastToken();
    const rows = await prisma.passwordResetToken.findMany();

    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(hashToken(token));
    expect(rows[0].tokenHash).not.toBe(token);
    expect(rows[0].usedAt).toBeNull();
    expect(rows[0].expiresAt.getTime()).toBeGreaterThan(Date.now() + 25 * MINUTE);
    expect(rows[0].expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 30 * MINUTE);
  });

  it("answers exactly the same for an unknown address, and sends nothing", async () => {
    await createAccount();

    const res = await forgot("nobody@example.com");

    expect(res.status).toBe(200);
    expect(res.body.message).toBe(GENERIC);
    expect(mails()).toHaveLength(0);
    expect(await prisma.passwordResetToken.count()).toBe(0);
  });

  it("matches the address ignoring case and surrounding spaces", async () => {
    await createAccount("priya@example.com");

    await forgot("  PRIYA@Example.COM ");

    expect(mails()).toHaveLength(1);
  });

  it("sends nothing to a deactivated account, but answers the same", async () => {
    await createAccount("gone@example.com", "INACTIVE");

    const res = await forgot("gone@example.com");

    expect(res.status).toBe(200);
    expect(res.body.message).toBe(GENERIC);
    expect(mails()).toHaveLength(0);
  });

  it("sends at most one email per account per minute", async () => {
    await createAccount();

    await forgot("priya@example.com");
    await forgot("priya@example.com");

    expect(mails()).toHaveLength(1);
    expect(await prisma.passwordResetToken.count()).toBe(1);
  });

  it("asking again later cancels the earlier link", async () => {
    const user = await createAccount();
    await forgot("priya@example.com");
    const first = lastToken();
    await ageTokens(5);

    await forgot("priya@example.com");
    const second = lastToken();

    expect(second).not.toBe(first);
    expect((await reset(first, NEW_PASSWORD)).status).toBe(400);
    expect((await reset(second, NEW_PASSWORD)).status).toBe(200);
    expect(await passwordIs(user.id, NEW_PASSWORD)).toBe(true);
  });

  it("rejects a malformed email and malformed JSON with 400", async () => {
    const bad = await forgot("not-an-email");
    expect(bad.status).toBe(400);
    expect(bad.body.field).toBe("email");

    const res = await forgotPassword(
      new NextRequest("http://localhost/api/auth/forgot-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_json");
  });
});

describe("forgot password: using the link", () => {
  it("changes the password, and the old one stops working", async () => {
    const user = await createAccount();
    await forgot("priya@example.com");

    const res = await reset(lastToken(), NEW_PASSWORD);

    expect(res.status).toBe(200);
    expect(await passwordIs(user.id, NEW_PASSWORD)).toBe(true);
    expect(await passwordIs(user.id, OLD_PASSWORD)).toBe(false);
  });

  it("a link works only once", async () => {
    const user = await createAccount();
    await forgot("priya@example.com");
    const token = lastToken();

    expect((await reset(token, NEW_PASSWORD)).status).toBe(200);
    const again = await reset(token, "a-different-password");

    expect(again.status).toBe(400);
    expect(again.body.error).toBe("invalid_token");
    expect(await passwordIs(user.id, NEW_PASSWORD)).toBe(true);
  });

  it("refuses an expired link", async () => {
    const user = await createAccount();
    await forgot("priya@example.com");
    const token = lastToken();
    await prisma.passwordResetToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await reset(token, NEW_PASSWORD);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_token");
    expect(await passwordIs(user.id, OLD_PASSWORD)).toBe(true);
  });

  it("refuses a made-up token", async () => {
    await createAccount();

    const res = await reset("this-token-was-never-issued", NEW_PASSWORD);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_token");
  });

  it("refuses the link if the account was deactivated after it was sent", async () => {
    const user = await createAccount();
    await forgot("priya@example.com");
    const token = lastToken();
    await prisma.user.update({ where: { id: user.id }, data: { status: "INACTIVE" } });

    const res = await reset(token, NEW_PASSWORD);

    expect(res.status).toBe(400);
    expect(await passwordIs(user.id, OLD_PASSWORD)).toBe(true);
  });

  it("a too-short password is rejected and does not use up the link", async () => {
    const user = await createAccount();
    await forgot("priya@example.com");
    const token = lastToken();

    const short = await reset(token, "short");

    expect(short.status).toBe(400);
    expect(short.body.field).toBe("password");
    expect(await passwordIs(user.id, OLD_PASSWORD)).toBe(true);
    expect((await reset(token, NEW_PASSWORD)).status).toBe(200);
  });

  it("the same link submitted twice at once succeeds exactly once", async () => {
    const user = await createAccount();
    await forgot("priya@example.com");
    const token = lastToken();

    const results = await Promise.all([reset(token, "first-password-1"), reset(token, "second-password-2")]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    const winner = results[0].status === 200 ? "first-password-1" : "second-password-2";
    expect(await passwordIs(user.id, winner)).toBe(true);
  });

  it("records both steps in the activity log, without the token", async () => {
    const user = await createAccount();
    await forgot("priya@example.com");
    const token = lastToken();
    await reset(token, NEW_PASSWORD);

    const logs = await prisma.activityLog.findMany({ where: { actorId: user.id }, orderBy: { id: "asc" } });

    expect(logs.map((l: { action: string }) => l.action)).toEqual([
      "password_reset_requested",
      "password_reset_completed",
    ]);
    expect(JSON.stringify(logs)).not.toContain(token);
  });
});
