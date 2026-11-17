import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { signupSchema } from "@/lib/schemas";
import { prisma, Prisma } from "@/lib/prisma";
import { findUserByEmail, normalizeEmail } from "@/lib/userLookup";
import { readJson, validationError } from "@/lib/http";
import { sendVerificationEmail } from "@/lib/emailVerification";
import { LIMITS, clientIp, rateLimit, tooManyRequests } from "@/lib/rateLimit";

const emailTaken = () =>
  NextResponse.json(
    { error: "email_taken", message: "An account with this email already exists", field: "email" },
    { status: 409 }
  );

export async function POST(req: NextRequest) {
  // Every attempt counts, successful or not.
  const limited = await rateLimit(LIMITS.signup, clientIp(req));
  if (!limited.allowed) return tooManyRequests(limited, "Too many sign-up attempts. Please try again later.");

  const json = await readJson(req);
  if (!json.ok) return json.response;

  // "  Priya@Example.COM " and "priya@example.com" are the same person.
  const raw = (json.body ?? {}) as Record<string, unknown>;
  const body = { ...raw, email: typeof raw.email === "string" ? normalizeEmail(raw.email) : raw.email };

  const parsed = signupSchema.safeParse(body);
  if (!parsed.success) return validationError(parsed.error);
  const { firstName, lastName, email, password } = parsed.data;

  if (await findUserByEmail(email)) return emailTaken();

  const passwordHash = await bcrypt.hash(password, 10);

  try {
    // role is hard-coded here, never taken from the request body —
    // this is what makes signup "non-self-elevating"
    const user = await prisma.user.create({
      data: { firstName, lastName, email, passwordHash, role: "EMPLOYEE" },
    });
    // They can't sign in until they open the emailed link.
    await sendVerificationEmail(user, new URL(req.url).origin);
    return NextResponse.json(
      { id: user.id, email: user.email, role: user.role, emailVerificationRequired: true },
      { status: 201 }
    );
  } catch (err) {
    // Two sign-ups for the same address at the same moment both pass the check
    // above; the database's unique index lets only one of them in.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return emailTaken();
    throw err;
  }
}