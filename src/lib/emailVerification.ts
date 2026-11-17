import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { findUserByEmail } from "@/lib/userLookup";
import { deliverEmail } from "@/lib/mailer";
import { appBaseUrl, hashToken } from "@/lib/passwordReset";

export const VERIFY_TOKEN_TTL_HOURS = 24;
// One verification email per account per minute, so the resend form can't flood an inbox.
const MIN_SECONDS_BETWEEN_SENDS = 60;

type HttpError = { status: number; body: Record<string, unknown> };
const invalidToken = (): HttpError => ({
  status: 400,
  body: {
    error: "invalid_token",
    message: "This verification link is invalid or has expired. Request a new one.",
  },
});

type Recipient = { id: number; email: string; firstName: string };

/**
 * Emails a fresh verification link. Any earlier unused link stops working.
 * Never throws: a mail problem must not fail signup; the person can ask again.
 */
export async function sendVerificationEmail(user: Recipient, requestOrigin: string): Promise<void> {
  try {
    const baseUrl = appBaseUrl(requestOrigin);
    if (!baseUrl) {
      console.error("[email-verification] APP_URL is not set; refusing to build a link from the request");
      return;
    }

    const token = randomBytes(32).toString("base64url");
    const now = new Date();
    await prisma.$transaction([
      prisma.emailVerificationToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: now } }),
      prisma.emailVerificationToken.create({
        data: {
          userId: user.id,
          tokenHash: hashToken(token),
          expiresAt: new Date(now.getTime() + VERIFY_TOKEN_TTL_HOURS * 3_600_000),
        },
      }),
    ]);

    await deliverEmail({
      to: user.email,
      subject: "Verify your AssetFlow email",
      text: [
        `Hi ${user.firstName},`,
        "",
        "Confirm your email address to finish setting up your AssetFlow account:",
        `${baseUrl}/verify-email?token=${token}`,
        "",
        `The link works once and expires after ${VERIFY_TOKEN_TTL_HOURS} hours.`,
        "If you didn't create an account, you can ignore this email.",
      ].join("\n"),
    });
  } catch (err) {
    console.error("could not send verification email:", (err as Error).message);
  }
}

/**
 * The resend form. Always resolves without saying whether the address has an
 * account, and does nothing for verified, deactivated or recently-emailed accounts.
 */
export async function resendVerification(email: string, requestOrigin: string): Promise<void> {
  const user = await findUserByEmail(email);
  if (!user || user.status !== "ACTIVE" || user.emailVerifiedAt) return;

  const recent = await prisma.emailVerificationToken.findFirst({
    where: {
      userId: user.id,
      usedAt: null,
      createdAt: { gt: new Date(Date.now() - MIN_SECONDS_BETWEEN_SENDS * 1000) },
    },
    select: { id: true },
  });
  if (recent) return;

  await sendVerificationEmail(user, requestOrigin);
}

/** Confirms the address. Throws { status, body } for a link that is unknown, expired or already used. */
export async function verifyEmail(token: string): Promise<void> {
  const found = await prisma.emailVerificationToken.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { select: { status: true } } },
  });
  if (!found || found.usedAt || found.expiresAt <= new Date() || found.user.status !== "ACTIVE") {
    throw invalidToken();
  }

  await prisma.$transaction(async (tx) => {
    const now = new Date();
    // Atomic claim: the same link opened twice at once verifies once, and the other call is refused.
    const claimed = await tx.emailVerificationToken.updateMany({
      where: { id: found.id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (claimed.count === 0) throw invalidToken();

    await tx.user.updateMany({ where: { id: found.userId, emailVerifiedAt: null }, data: { emailVerifiedAt: now } });
    await tx.emailVerificationToken.updateMany({ where: { userId: found.userId, usedAt: null }, data: { usedAt: now } });
  });
}
