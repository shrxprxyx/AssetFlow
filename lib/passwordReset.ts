import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma, Prisma } from "@/lib/prisma";
import { findUserByEmail } from "@/lib/userLookup";
import { deliverEmail } from "@/lib/mailer";
import { logActivity } from "@/lib/logActivity";

export const RESET_TOKEN_TTL_MINUTES = 30;
// One reset email per account per minute, so the form can't be used to flood an inbox.
const MIN_SECONDS_BETWEEN_REQUESTS = 60;

type HttpError = { status: number; body: Record<string, unknown> };
const invalidToken = (): HttpError => ({
  status: 400,
  body: {
    error: "invalid_token",
    message: "This reset link is invalid or has expired. Request a new one.",
  },
});

/** Only the hash is stored; the token itself exists only in the emailed link. */
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Where the link in the email points.
 *
 * In production this must come from configuration, never from the request:
 * the request's Host header is chosen by the caller, so trusting it would let
 * an attacker have a victim emailed a reset link that points at the attacker's
 * own site.
 */
function appBaseUrl(requestOrigin: string): string | null {
  const configured = process.env.APP_URL ?? process.env.AUTH_URL ?? process.env.NEXTAUTH_URL;
  if (configured) return configured.replace(/\/+$/, "");
  if (process.env.NODE_ENV === "production") return null;
  return requestOrigin;
}

/**
 * Starts a password reset. Always resolves without saying whether the address
 * belongs to an account: the caller shows the same message either way, so the
 * form can't be used to find out who has an account.
 */
export async function requestPasswordReset(email: string, requestOrigin: string): Promise<void> {
  const user = await findUserByEmail(email);
  if (!user || user.status !== "ACTIVE") return;

  const now = new Date();

  const recent = await prisma.passwordResetToken.findFirst({
    where: {
      userId: user.id,
      usedAt: null,
      createdAt: { gt: new Date(now.getTime() - MIN_SECONDS_BETWEEN_REQUESTS * 1000) },
    },
    select: { id: true },
  });
  if (recent) return;

  const baseUrl = appBaseUrl(requestOrigin);
  if (!baseUrl) {
    console.error("[password-reset] APP_URL is not set; refusing to build a reset link from the request");
    return;
  }

  const token = randomBytes(32).toString("base64url");

  await prisma.$transaction([
    // Asking again cancels any earlier link that hasn't been used.
    prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: now },
    }),
    prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(now.getTime() + RESET_TOKEN_TTL_MINUTES * 60_000),
      },
    }),
  ]);

  await deliverEmail({
    to: user.email,
    subject: "Reset your AssetFlow password",
    text: [
      `Hi ${user.firstName},`,
      "",
      "Someone asked to reset the password for your AssetFlow account.",
      `Open this link within ${RESET_TOKEN_TTL_MINUTES} minutes to choose a new one:`,
      "",
      `${baseUrl}/reset-password?token=${token}`,
      "",
      "If this wasn't you, ignore this email. Your password has not changed.",
    ].join("\n"),
  });

  try {
    await logActivity("password_reset_requested", {
      actorId: user.id,
      resourceType: "User",
      resourceId: user.id,
    });
  } catch (err) {
    console.error("activity log failed for password_reset_requested", err);
  }
}

/**
 * Finishes a password reset. Throws { status, body } for a link that is
 * unknown, expired, already used, or belongs to a deactivated account.
 */
export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const tokenHash = hashToken(token);

  // Cheap check first, so a bad link is refused without paying for a bcrypt hash.
  const found = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    include: { user: { select: { id: true, status: true } } },
  });
  if (!found || found.usedAt || found.expiresAt <= new Date() || found.user.status !== "ACTIVE") {
    throw invalidToken();
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Atomic claim: if the same link is submitted twice at once, only one
    // request flips usedAt from NULL; the other sees count === 0.
    const now = new Date();
    const claimed = await tx.passwordResetToken.updateMany({
      where: { id: found.id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (claimed.count === 0) throw invalidToken();

    await tx.user.update({ where: { id: found.userId }, data: { passwordHash } });

    // Any other outstanding link for this account is dead too.
    await tx.passwordResetToken.updateMany({
      where: { userId: found.userId, usedAt: null },
      data: { usedAt: now },
    });
  });

  try {
    await logActivity("password_reset_completed", {
      actorId: found.userId,
      resourceType: "User",
      resourceId: found.userId,
    });
  } catch (err) {
    console.error("activity log failed for password_reset_completed", err);
  }
}
