import bcrypt from "bcryptjs";
import { findUserByEmail } from "@/lib/userLookup";

export type CredentialResult =
  | { ok: true; user: NonNullable<Awaited<ReturnType<typeof findUserByEmail>>> }
  | { ok: false; reason: "invalid" | "unverified" };

/**
 * Checks an email and password. Kept apart from NextAuth so it can be tested.
 *
 * "unverified" is only returned after the password was right, so it can't be
 * used to find out which addresses have accounts. Wrong password, unknown
 * address and deactivated account are all the same "invalid".
 */
export async function checkCredentials(email: string, password: string): Promise<CredentialResult> {
  const user = await findUserByEmail(email);
  if (!user || user.status !== "ACTIVE") return { ok: false, reason: "invalid" };

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return { ok: false, reason: "invalid" };

  if (!user.emailVerifiedAt) return { ok: false, reason: "unverified" };
  return { ok: true, user };
}
