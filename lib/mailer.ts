import { enqueueEmail, type EmailJobData } from "@/lib/queue";

export type Email = EmailJobData;

/**
 * Actually sends one email. This is the ONLY function to change when a real
 * mail provider is added (Resend, SES, SMTP via nodemailer, ...).
 *
 * Until then it prints the email to the console of whichever process sends it
 * (the worker, or the web app when Redis is down), which is enough to develop
 * and demo with: copy the reset link out of the terminal.
 */
export async function sendMail(email: Email): Promise<void> {
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
