import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";
import Credentials from "next-auth/providers/credentials";
import { CredentialsSignin } from "next-auth";
import bcrypt from "bcryptjs";
import { findUserByEmail } from "@/lib/userLookup";
import { clientIp } from "@/lib/rateLimit";
import { consumeLoginAttempt, clearLoginFailures } from "@/lib/loginLimit";

/** Too many sign-in attempts. The login page shows a "try again later" message for code "rate_limited". */
class RateLimitedError extends CredentialsSignin {
  code = "rate_limited";
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials, request) {
        if (!credentials?.email || !credentials?.password) return null;

        // Counted before any password work, so guessing is slowed down too.
        const attempt = await consumeLoginAttempt(credentials.email as string, clientIp(request));
        if (!attempt.allowed) throw new RateLimitedError();

        // Case-insensitive, so "Priya@X.com" and "priya@x.com" reach the same account.
        const user = await findUserByEmail(credentials.email as string);
        if (!user) return null;

        // Deactivated accounts can't sign in. Checked before the password so a
        // deactivated user gets the same generic error either way.
        if (user.status !== "ACTIVE") return null;

        const valid = await bcrypt.compare(credentials.password as string, user.passwordHash);
        if (!valid) return null;

        await clearLoginFailures(credentials.email as string);

        return {
          id: String(user.id),
          email: user.email,
          name: `${user.firstName} ${user.lastName}`,
          role: user.role,
          departmentId: user.departmentId,
        };
      },
    }),
  ],
});
