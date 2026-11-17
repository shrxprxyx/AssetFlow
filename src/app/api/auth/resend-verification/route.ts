import { NextRequest, NextResponse } from "next/server";
import { forgotPasswordSchema } from "@/utils/schemas";
import { normalizeEmail } from "@/services/userLookup";
import { resendVerification } from "@/services/emailVerification";
import { readJson, validationError } from "@/utils/http";
import { LIMITS, clientIp, rateLimit, tooManyRequests } from "@/services/rateLimit";

// POST /api/auth/resend-verification  { email }
// Public. Answers the same way whether or not the address has an account.
export async function POST(req: NextRequest) {
  const limited = await rateLimit(LIMITS.resendVerification, clientIp(req));
  if (!limited.allowed) return tooManyRequests(limited, "Too many requests. Please try again later.");

  const json = await readJson(req);
  if (!json.ok) return json.response;
  const raw = (json.body ?? {}) as Record<string, unknown>;
  const parsed = forgotPasswordSchema.safeParse({
    ...raw,
    email: typeof raw.email === "string" ? normalizeEmail(raw.email) : raw.email,
  });
  if (!parsed.success) return validationError(parsed.error);

  try {
    await resendVerification(parsed.data.email, new URL(req.url).origin);
  } catch (err) {
    console.error("resend verification failed", err);
  }

  return NextResponse.json({
    ok: true,
    message: "If that account still needs verifying, a new link has been sent.",
  });
}
