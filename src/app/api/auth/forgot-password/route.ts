import { NextRequest, NextResponse } from "next/server";
import { forgotPasswordSchema } from "@/utils/schemas";
import { normalizeEmail } from "@/services/userLookup";
import { requestPasswordReset } from "@/services/passwordReset";
import { readJson, validationError } from "@/utils/http";
import { LIMITS, clientIp, rateLimit, tooManyRequests } from "@/services/rateLimit";

// POST /api/auth/forgot-password  { email }
// Public. Answers the same way whether or not the address has an account.
export async function POST(req: NextRequest) {
  // Limits by address only, so the answer never depends on whether an account exists.
  const limited = await rateLimit(LIMITS.forgotPassword, clientIp(req));
  if (!limited.allowed) return tooManyRequests(limited, "Too many reset requests. Please try again later.");

  const json = await readJson(req);
  if (!json.ok) return json.response;

  const raw = (json.body ?? {}) as Record<string, unknown>;
  const parsed = forgotPasswordSchema.safeParse({
    ...raw,
    email: typeof raw.email === "string" ? normalizeEmail(raw.email) : raw.email,
  });
  if (!parsed.success) return validationError(parsed.error);

  try {
    await requestPasswordReset(parsed.data.email, new URL(req.url).origin);
  } catch (err) {
    // Still answer normally: an error here must not reveal that the account exists.
    console.error("password reset request failed", err);
  }

  return NextResponse.json({
    ok: true,
    message: "If an account exists for that email, a reset link has been sent.",
  });
}
