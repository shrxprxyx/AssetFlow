import { NextRequest, NextResponse } from "next/server";
import { forgotPasswordSchema } from "@/lib/schemas";
import { normalizeEmail } from "@/lib/userLookup";
import { requestPasswordReset } from "@/lib/passwordReset";
import { readJson, validationError } from "@/lib/http";

// POST /api/auth/forgot-password  { email }
// Public. Answers the same way whether or not the address has an account.
export async function POST(req: NextRequest) {
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
