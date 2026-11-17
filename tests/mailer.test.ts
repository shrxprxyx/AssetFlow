import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const sendMailFn = vi.fn(async () => ({}));
const createTransport = vi.fn(() => ({ sendMail: sendMailFn }));
vi.mock("nodemailer", () => ({ createTransport }));

import { readSmtpConfig, sendMail } from "@/services/mailer";

const SMTP_KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "MAIL_FROM"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of SMTP_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  sendMailFn.mockClear();
  createTransport.mockClear();
});
afterEach(() => {
  for (const k of SMTP_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

const mail = { to: "priya@example.com", subject: "Hello", text: "Body" };

describe("readSmtpConfig", () => {
  it("is null when no SMTP_HOST is set", () => {
    expect(readSmtpConfig({})).toBeNull();
    expect(readSmtpConfig({ SMTP_HOST: "   " })).toBeNull();
  });

  it("reads a full config, using STARTTLS on 587 by default", () => {
    expect(
      readSmtpConfig({ SMTP_HOST: "smtp.x.com", SMTP_USER: "me", SMTP_PASS: "pw", MAIL_FROM: "AssetFlow <a@x.com>" })
    ).toEqual({ host: "smtp.x.com", port: 587, secure: false, user: "me", pass: "pw", from: "AssetFlow <a@x.com>" });
  });

  it("uses TLS from the start on port 465", () => {
    expect(readSmtpConfig({ SMTP_HOST: "h", SMTP_PORT: "465", MAIL_FROM: "a@x.com" })).toMatchObject({ port: 465, secure: true });
  });

  it("needs no login for a server that doesn't ask for one", () => {
    const c = readSmtpConfig({ SMTP_HOST: "localhost", SMTP_PORT: "1025", MAIL_FROM: "a@x.com", SMTP_PASS: "ignored" });

    expect(c?.user).toBeUndefined();
    expect(c?.pass).toBeUndefined();
  });

  it("fails loudly when half configured", () => {
    expect(() => readSmtpConfig({ SMTP_HOST: "smtp.x.com" })).toThrow(/MAIL_FROM/);
    for (const port of ["abc", "0", "70000", "25.5"]) {
      expect(() => readSmtpConfig({ SMTP_HOST: "h", MAIL_FROM: "a@x.com", SMTP_PORT: port })).toThrow(/SMTP_PORT/);
    }
  });
});

describe("sendMail", () => {
  it("prints to the console, and sends nothing, when SMTP is not configured", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await sendMail(mail);

    expect(createTransport).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join("\n")).toContain("priya@example.com");
  });

  it("sends through the SMTP server when configured", async () => {
    process.env.SMTP_HOST = "smtp.x.com";
    process.env.SMTP_USER = "me";
    process.env.SMTP_PASS = "pw";
    process.env.MAIL_FROM = "AssetFlow <a@x.com>";

    await sendMail(mail);

    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: "smtp.x.com", port: 587, secure: false, auth: { user: "me", pass: "pw" } })
    );
    expect(sendMailFn).toHaveBeenCalledWith({
      from: "AssetFlow <a@x.com>",
      to: "priya@example.com",
      subject: "Hello",
      text: "Body",
    });
  });

  it("reuses one connection for later emails", async () => {
    process.env.SMTP_HOST = "reuse.x.com";
    process.env.MAIL_FROM = "a@x.com";

    await sendMail(mail);
    await sendMail(mail);

    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(sendMailFn).toHaveBeenCalledTimes(2);
  });

  it("lets a refusal by the server through, so the queue retries", async () => {
    process.env.SMTP_HOST = "refuse.x.com";
    process.env.MAIL_FROM = "a@x.com";
    sendMailFn.mockRejectedValueOnce(new Error("550 mailbox unavailable"));

    await expect(sendMail(mail)).rejects.toThrow("550");
  });

  it("strips line breaks from the recipient and subject", async () => {
    process.env.SMTP_HOST = "inject.x.com";
    process.env.MAIL_FROM = "a@x.com";

    await sendMail({ to: "a@x.com\r\nBcc: evil@x.com", subject: "Hi\nBcc: evil@x.com", text: "line1\nline2" });

    const sent = (sendMailFn.mock.calls as unknown as Record<string, string>[][])[0][0];
    expect(sent.to).not.toMatch(/[\r\n]/);
    expect(sent.subject).not.toMatch(/[\r\n]/);
    expect(sent.text).toBe("line1\nline2"); // the body keeps its line breaks
  });

  it("fails when SMTP_HOST is set without a sender", async () => {
    process.env.SMTP_HOST = "smtp.x.com";

    await expect(sendMail(mail)).rejects.toThrow(/MAIL_FROM/);
  });
});
