import { describe, it, expect, beforeEach, vi } from "vitest";
import bcrypt from "bcryptjs";

vi.mock("@/lib/mailer", () => ({
  deliverEmail: vi.fn(async () => undefined),
  sendMail: vi.fn(async () => undefined),
}));

import { POST as signup } from "@/app/api/auth/signup/route";
import { POST as verify } from "@/app/api/auth/verify-email/route";
import { POST as resend } from "@/app/api/auth/resend-verification/route";
import { POST as resetPasswordRoute } from "@/app/api/auth/reset-password/route";
import { POST as forgotPassword } from "@/app/api/auth/forgot-password/route";
import { deliverEmail } from "@/lib/mailer";
import { hashToken } from "@/lib/passwordReset";
import { checkCredentials } from "@/lib/credentials";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./helpers/db";
import { call } from "./helpers/http";

const HOUR = 3_600_000;
const PASSWORD = "correct-horse-battery";
const GENERIC = "If that account still needs verifying, a new link has been sent.";

const join = (email = "priya@example.com") =>
  call(signup, "POST", "/api/auth/signup", { firstName: "Priya", lastName: "Shah", email, password: PASSWORD });
const confirm = (token: unknown) => call(verify, "POST", "/api/auth/verify-email", { token });
const again = (email: unknown) => call(resend, "POST", "/api/auth/resend-verification", { email });

const mails = () => vi.mocked(deliverEmail).mock.calls.map(([m]) => m);
function lastToken() {
  const last = mails().at(-1);
  if (!last) throw new Error("no email was sent");
  const match = /\/verify-email\?token=([\w-]+)/.exec(last.text);
  if (!match) throw new Error("the email has no verification link");
  return match[1];
}
const userByEmail = (email = "priya@example.com") => prisma.user.findFirstOrThrow({ where: { email } });
/** Pretend the last email was sent a while ago, so the resend throttle is over. */
const ageTokens = () =>
  prisma.emailVerificationToken.updateMany({ data: { createdAt: new Date(Date.now() - 5 * 60_000) } });

describe("email verification", () => {
  beforeEach(async () => {
    await resetDb();
    vi.mocked(deliverEmail).mockClear();
  });

  describe("signup", () => {
    it("creates an unverified account and emails a link", async () => {
      const res = await join();

      expect(res.status).toBe(201);
      expect(res.body.emailVerificationRequired).toBe(true);
      expect((await userByEmail()).emailVerifiedAt).toBeNull();
      expect(mails()).toHaveLength(1);
      expect(mails()[0].to).toBe("priya@example.com");
      expect(lastToken().length).toBeGreaterThan(20);
    });

    it("stores only a hash of the token", async () => {
      await join();
      const stored = await prisma.emailVerificationToken.findFirstOrThrow();

      expect(stored.tokenHash).toBe(hashToken(lastToken()));
      expect(stored.tokenHash).not.toContain(lastToken());
    });

    it("still creates the account when the email cannot be sent", async () => {
      vi.mocked(deliverEmail).mockRejectedValueOnce(new Error("smtp down"));

      expect((await join()).status).toBe(201);
      expect(await prisma.user.count()).toBe(1);
    });
  });

  describe("sign-in check", () => {
    it("refuses an unverified account, but only after the right password", async () => {
      await join();

      expect(await checkCredentials("priya@example.com", PASSWORD)).toEqual({ ok: false, reason: "unverified" });
      // A wrong password looks the same as an unknown account: nothing to learn about who has an account.
      expect(await checkCredentials("priya@example.com", "wrong-password")).toEqual({ ok: false, reason: "invalid" });
      expect(await checkCredentials("nobody@example.com", PASSWORD)).toEqual({ ok: false, reason: "invalid" });
    });

    it("lets a verified account in, whatever the letter case of the address", async () => {
      await join();
      expect((await confirm(lastToken())).status).toBe(200);

      const result = await checkCredentials("Priya@Example.com", PASSWORD);

      expect(result.ok).toBe(true);
    });

    it("refuses a deactivated account as invalid", async () => {
      await join();
      await confirm(lastToken());
      await prisma.user.update({ where: { id: (await userByEmail()).id }, data: { status: "INACTIVE" } });

      expect(await checkCredentials("priya@example.com", PASSWORD)).toEqual({ ok: false, reason: "invalid" });
    });
  });

  describe("verify", () => {
    it("marks the email verified", async () => {
      await join();
      const res = await confirm(lastToken());

      expect(res.status).toBe(200);
      expect((await userByEmail()).emailVerifiedAt).toBeInstanceOf(Date);
    });

    it("works once", async () => {
      await join();
      const token = lastToken();
      await confirm(token);

      const second = await confirm(token);

      expect(second.status).toBe(400);
      expect(second.body.error).toBe("invalid_token");
    });

    it("refuses an expired link", async () => {
      await join();
      await prisma.emailVerificationToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

      expect((await confirm(lastToken())).status).toBe(400);
      expect((await userByEmail()).emailVerifiedAt).toBeNull();
    });

    it("refuses an unknown, empty or missing token", async () => {
      await join();

      expect((await confirm("not-a-real-token")).status).toBe(400);
      expect((await confirm("")).status).toBe(400);
      expect((await confirm(undefined)).status).toBe(400);
    });

    it("refuses a link for a deactivated account", async () => {
      await join();
      await prisma.user.update({ where: { id: (await userByEmail()).id }, data: { status: "INACTIVE" } });

      expect((await confirm(lastToken())).status).toBe(400);
    });

    it("lets only one of two simultaneous opens succeed", async () => {
      await join();
      const token = lastToken();

      const results = await Promise.all([confirm(token), confirm(token)]);

      expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    });

    it("keeps the first verification time when verified again", async () => {
      await join();
      await confirm(lastToken());
      const first = (await userByEmail()).emailVerifiedAt;
      await ageTokens();
      // Verified accounts get no new link, so force one the way a stale email could.
      await prisma.emailVerificationToken.create({
        data: { userId: (await userByEmail()).id, tokenHash: hashToken("late"), expiresAt: new Date(Date.now() + HOUR) },
      });

      await confirm("late");

      expect((await userByEmail()).emailVerifiedAt).toEqual(first);
    });
  });

  describe("resend", () => {
    it("sends a new link and cancels the old one", async () => {
      await join();
      const oldToken = lastToken();
      await ageTokens();

      const res = await again("priya@example.com");

      expect(res.body.message).toBe(GENERIC);
      expect(mails()).toHaveLength(2);
      expect((await confirm(oldToken)).status).toBe(400);
      expect((await confirm(lastToken())).status).toBe(200);
    });

    it("answers the same, and sends nothing, for an unknown address", async () => {
      const res = await again("nobody@example.com");

      expect(res.status).toBe(200);
      expect(res.body.message).toBe(GENERIC);
      expect(mails()).toHaveLength(0);
    });

    it("sends nothing to an account that is already verified", async () => {
      await join();
      await confirm(lastToken());
      vi.mocked(deliverEmail).mockClear();

      expect((await again("priya@example.com")).body.message).toBe(GENERIC);
      expect(mails()).toHaveLength(0);
    });

    it("sends at most one email a minute per account", async () => {
      await join();
      await again("priya@example.com");
      await again("priya@example.com");

      expect(mails()).toHaveLength(1); // only the one from signup
    });

    it("rejects a malformed address", async () => {
      expect((await again("not-an-email")).status).toBe(400);
    });
  });

  describe("password reset also proves the address", () => {
    it("verifies an unverified account", async () => {
      await join();
      vi.mocked(deliverEmail).mockClear();
      await call(forgotPassword, "POST", "/api/auth/forgot-password", { email: "priya@example.com" });
      const token = /\/reset-password\?token=([\w-]+)/.exec(mails().at(-1)!.text)![1];

      const res = await call(resetPasswordRoute, "POST", "/api/auth/reset-password", { token, password: "a-new-password-1" });

      expect(res.status).toBe(200);
      expect((await userByEmail()).emailVerifiedAt).toBeInstanceOf(Date);
      expect(await bcrypt.compare("a-new-password-1", (await userByEmail()).passwordHash)).toBe(true);
    });
  });
});
