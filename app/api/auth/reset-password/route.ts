import { NextRequest, NextResponse } from "next/server";
import { resetPasswordSchema } from "@/lib/schemas";
import { resetPassword } from "@/lib/passwordReset";
import { readJson, validationError } from "@/lib/http";
import { LIMITS, clientIp, rateLimit, tooManyRequests } from "@/lib/rateLimit";

// POST /api/auth/reset-password  { token, password }
// Public. The token from the emailed link is the proof of identity.
export async function POST(req: NextRequest) {
  const limited = await rateLimit(LIMITS.resetPassword, clientIp(req));
  if (!limited.allowed) return tooManyRequests(limited, "Too many attempts. Please try again later.");

  const json = await readJson(req);
  if (!json.ok) return json.response;
  const parsed = resetPasswordSchema.safeParse(json.body);
  if (!parsed.success) return validationError(parsed.error);

  try {
    await resetPassword(parsed.data.token, parsed.data.password);
    return NextResponse.json({ ok: true, message: "Your password has been changed. You can sign in now." });
  } catch (e) {
    // resetPassword throws { status, body } for a bad, expired or used link.
    const known = e as { status?: number; body?: Record<string, unknown> };
    if (known?.status && known?.body) return NextResponse.json(known.body, { status: known.status });
    console.error(e);
    return NextResponse.json(
      { error: "server_error", message: "Something went wrong resetting the password" },
      { status: 500 }
    );
  }
}
