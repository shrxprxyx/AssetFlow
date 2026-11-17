import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/services/mailer", () => ({
  deliverEmail: vi.fn(async () => undefined),
  sendMail: vi.fn(async () => undefined),
}));

import { GET as heatmap } from "@/app/api/reports/heatmap/route";
import { POST as signOutEverywhere } from "@/app/api/account/sign-out-everywhere/route";
import { PATCH as setStatus } from "@/app/api/employees/[id]/status/route";
import { POST as forgotPassword } from "@/app/api/auth/forgot-password/route";
import { POST as resetPasswordRoute } from "@/app/api/auth/reset-password/route";
import { deliverEmail } from "@/services/mailer";
import { prisma } from "@/services/prisma";
import { auth } from "@/auth";
import { resetDb, createUser } from "./helpers/db";
import { signInAs } from "./helpers/auth";
import { call, jsonRequest } from "./helpers/http";

const protectedCall = () => call(heatmap, "GET", "/api/reports/heatmap");
const versionOf = async (id: number) => (await prisma.user.findUniqueOrThrow({ where: { id } })).sessionVersion;

describe("session revocation", () => {
  beforeEach(async () => {
    await resetDb();
    vi.mocked(deliverEmail).mockClear();
  });

  it("accepts a session whose version matches", async () => {
    const user = await createUser({ role: "ASSET_MANAGER" });
    signInAs(user);

    expect((await protectedCall()).status).toBe(200);
  });

  it("treats a session from before versions existed as version 0", async () => {
    const user = await createUser({ role: "ASSET_MANAGER" });
    signInAs(user);
    const session = await auth();
    delete (session as { user: { sessionVersion?: number } }).user.sessionVersion;
    vi.mocked(auth).mockResolvedValue(session as never);

    expect((await protectedCall()).status).toBe(200);
  });

  it("rejects a session once the version has moved on", async () => {
    const user = await createUser({ role: "ASSET_MANAGER" });
    signInAs(user);
    await prisma.user.update({ where: { id: user.id }, data: { sessionVersion: { increment: 1 } } });

    const res = await protectedCall();

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  it("rejects a session claiming a newer version than the database has", async () => {
    const user = await createUser({ role: "ASSET_MANAGER" });
    signInAs({ ...user, sessionVersion: 5 });

    expect((await protectedCall()).status).toBe(401);
  });

  describe("sign out everywhere", () => {
    it("ends the session that asked, and every other one", async () => {
      const user = await createUser({ role: "ASSET_MANAGER" });
      signInAs(user);

      expect((await call(signOutEverywhere as never, "POST", "/api/account/sign-out-everywhere")).status).toBe(200);

      expect(await versionOf(user.id)).toBe(user.sessionVersion + 1);
      expect((await protectedCall()).status).toBe(401); // the old session, still carrying the old version
    });

    it("does not touch anyone else's sessions", async () => {
      const me = await createUser({ role: "ASSET_MANAGER" });
      const other = await createUser({ role: "ASSET_MANAGER" });
      signInAs(me);

      await call(signOutEverywhere as never, "POST", "/api/account/sign-out-everywhere");

      expect(await versionOf(other.id)).toBe(other.sessionVersion);
    });

    it("needs a signed-in user", async () => {
      vi.mocked(auth).mockResolvedValue(null as never);

      expect((await call(signOutEverywhere as never, "POST", "/api/account/sign-out-everywhere")).status).toBe(401);
    });
  });

  describe("password reset", () => {
    it("ends the sessions that were open before it", async () => {
      const user = await createUser({ role: "ASSET_MANAGER" });
      signInAs(user);
      await call(forgotPassword, "POST", "/api/auth/forgot-password", { email: user.email });
      const token = /\/reset-password\?token=([\w-]+)/.exec(vi.mocked(deliverEmail).mock.calls.at(-1)![0].text)![1];

      await call(resetPasswordRoute, "POST", "/api/auth/reset-password", { token, password: "a-new-password-1" });

      expect(await versionOf(user.id)).toBe(user.sessionVersion + 1);
      expect((await protectedCall()).status).toBe(401);
    });
  });

  describe("deactivating and reactivating an account", () => {
    const setTo = (id: number, status: string) =>
      (setStatus as (r: ReturnType<typeof jsonRequest>, c: { params: Promise<{ id: string }> }) => Promise<Response>)(
        jsonRequest(`/api/employees/${id}/status`, "PATCH", { status }),
        { params: Promise.resolve({ id: String(id) }) }
      );

    it("does not bring old sessions back when the account is reactivated", async () => {
      const admin = await createUser({ role: "ADMIN" });
      const staff = await createUser({ role: "ASSET_MANAGER" });

      signInAs(admin);
      await setTo(staff.id, "INACTIVE");
      await setTo(staff.id, "ACTIVE");

      signInAs(staff); // still carries the version it had before
      expect(await versionOf(staff.id)).toBe(staff.sessionVersion + 2);
      expect((await protectedCall()).status).toBe(401);
    });
  });
});
