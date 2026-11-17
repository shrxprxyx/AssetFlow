import { LIMITS, rateLimit, resetRateLimit, type RateLimitResult } from "@/services/rateLimit";

export const LOGIN_EMAIL_RULE = LIMITS.loginEmail;
export const LOGIN_IP_RULE = LIMITS.loginIp;

const emailKey = (email: string) => email.trim().toLowerCase();

/**
 * Counts one sign-in attempt against the account AND the caller's address.
 * The account limit stops guessing one password list against one person; the
 * address limit stops one machine trying many accounts. Allowed only if both are.
 */
export async function consumeLoginAttempt(email: string, ip: string): Promise<RateLimitResult> {
  const [byEmail, byIp] = await Promise.all([
    rateLimit(LOGIN_EMAIL_RULE, emailKey(email)),
    rateLimit(LOGIN_IP_RULE, ip),
  ]);
  if (!byEmail.allowed) return byEmail;
  return byIp;
}

/** A correct password gives the account its attempts back. */
export function clearLoginFailures(email: string) {
  return resetRateLimit(LOGIN_EMAIL_RULE, emailKey(email));
}
