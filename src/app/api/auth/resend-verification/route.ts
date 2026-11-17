import { NextRequest, NextResponse } from "next/server";
import { forgotPasswordSchema } from "@/lib/schemas";
import { normalizeEmail } from "@/lib/userLookup";
import { resendVerification } from "@/lib/emailVerification";
import { readJson, validationError } from "@/lib/http";
import { LIMITS, clientIp, rateLimit, tooManyRequests } from "@/lib/rateLimit";

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
