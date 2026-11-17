import { enqueueEmail, type EmailJobData } from "@/lib/queue";

export type Email = EmailJobData;

export type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
};

/**
 * Reads the SMTP settings from the environment.
 *
 *   SMTP_HOST   mail server, e.g. smtp.gmail.com        (unset = print emails to the console)
 *   SMTP_PORT   default 587 (STARTTLS); 465 uses TLS from the start
 *   SMTP_USER / SMTP_PASS   login, if the server wants one
 *   MAIL_FROM   sender, e.g. AssetFlow <no-reply@example.com>   (required with SMTP_HOST)
 *
 * Returns null when no SMTP_HOST is set. Throws when SMTP_HOST is set but the
 * rest is unusable, so a half-configured server fails loudly instead of
 * silently dropping mail.
 */
export function readSmtpConfig(env: Record<string, string | undefined> = process.env): SmtpConfig | null {
  const host = env.SMTP_HOST?.trim();
  if (!host) return null;

  const from = env.MAIL_FROM?.trim();
  if (!from) throw new Error("SMTP_HOST is set but MAIL_FROM is not");

  const port = env.SMTP_PORT?.trim() ? Number(env.SMTP_PORT) : 587;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`SMTP_PORT "${env.SMTP_PORT}" is not a valid port`);

  const user = env.SMTP_USER?.trim() || undefined;
  return { host, port, secure: port === 465, user, pass: user ? env.SMTP_PASS : undefined, from };
}

/** A header value can't contain line breaks: that is how extra headers get smuggled in. */
const oneLine = (value: string) => value.replace(/[\r\n]+/g, " ").trim();

type Transport = { sendMail(message: Record<string, unknown>): Promise<unknown> };
let cached: { key: string; transport: Transport } | undefined;

async function transportFor(config: SmtpConfig): Promise<Transport> {
  const key = JSON.stringify(config);
  if (cached?.key === key) return cached.transport;
  // Loaded only when SMTP is configured, so console-only development never needs it.
  const { createTransport } = await import("nodemailer");
  const transport = createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user ? { user: config.user, pass: config.pass } : undefined,
    connectionTimeout: 10_000,
    socketTimeout: 20_000,
  });
  cached = { key, transport };
  return transport;
}

/**
 * Actually sends one email. This is the ONLY function that talks to a mail server.
 *
 * With SMTP_HOST set it sends through that server, and throws if the server
 * refuses, so the worker's queue retries the job. Without it the email is
 * printed to the console of whichever process sends it (the worker, or the web
 * app when Redis is down), which is enough to develop and demo with: copy the
 * link out of the terminal.
 */
export async function sendMail(email: Email): Promise<void> {
  const config = readSmtpConfig();

  if (!config) {
    if (process.env.NODE_ENV === "production") {
      console.error("[mail] SMTP_HOST is not set: emails are only printed, nobody receives them");
    }
    console.log(
      [
        "",
        "──────── email (no mail provider configured; printed instead) ────────",
        `To:      ${email.to}`,
        `Subject: ${email.subject}`,
        "",
        email.text,
        "───────────────────────────────────────────────────────────────────────",
        "",
      ].join("\n")
    );
    return;
  }

  const transport = await transportFor(config);
  await transport.sendMail({
    from: config.from,
    to: oneLine(email.to),
    subject: oneLine(email.subject),
    text: email.text,
  });
}

/**
 * Hands an email to the worker through the queue so the request doesn't wait
 * for it. If it can't be queued (Redis down, or QUEUE_MODE=inline) it is sent
 * right here instead. Never throws: a mail problem must not fail the request.
 */
export async function deliverEmail(email: Email): Promise<void> {
  try {
    if (await enqueueEmail(email)) return;
    await sendMail(email);
  } catch (err) {
    console.error("could not send email:", (err as Error).message);
  }
}
