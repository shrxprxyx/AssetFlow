import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyEmail } from "@/lib/emailVerification";
import { readJson, validationError } from "@/lib/http";
import { LIMITS, clientIp, rateLimit, tooManyRequests } from "@/lib/rateLimit";

const schema = z.object({ token: z.string().min(1, "Verification link is missing its token") });

// POST /api/auth/verify-email  { token }
// Public. The token from the emailed link is the proof.
export async function POST(req: NextRequest) {
  const limited = await rateLimit(LIMITS.verifyEmail, clientIp(req));
  if (!limited.allowed) return tooManyRequests(limited, "Too many attempts. Please try again later.");

  const json = await readJson(req);
  if (!json.ok) return json.response;
  const parsed = schema.safeParse(json.body);
  if (!parsed.success) return validationError(parsed.error);

  try {
    await verifyEmail(parsed.data.token);
    return NextResponse.json({ ok: true, message: "Your email is verified. You can sign in now." });
  } catch (e) {
    const known = e as { status?: number; body?: Record<string, unknown> };
    if (known?.status && known?.body) return NextResponse.json(known.body, { status: known.status });
    console.error(e);
    return NextResponse.json({ error: "server_error", message: "Something went wrong verifying the email" }, { status: 500 });
  }
}
