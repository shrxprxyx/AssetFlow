import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";
import Credentials from "next-auth/providers/credentials";
import { CredentialsSignin } from "next-auth";
import { checkCredentials } from "@/services/credentials";
import { clientIp } from "@/services/rateLimit";
import { consumeLoginAttempt, clearLoginFailures } from "@/services/loginLimit";

/** Too many sign-in attempts. The login page shows a "try again later" message for code "rate_limited". */
class RateLimitedError extends CredentialsSignin {
  code = "rate_limited";
}

/** The password was right but the email address was never confirmed. */
class EmailNotVerifiedError extends CredentialsSignin {
  code = "email_not_verified";
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

        const result = await checkCredentials(credentials.email as string, credentials.password as string);
        if (!result.ok) {
          if (result.reason === "unverified") throw new EmailNotVerifiedError();
          return null;
        }
        const user = result.user;

        await clearLoginFailures(credentials.email as string);

        return {
          id: String(user.id),
          email: user.email,
          name: `${user.firstName} ${user.lastName}`,
          role: user.role,
          departmentId: user.departmentId,
          sessionVersion: user.sessionVersion,
        };
      },
    }),
  ],
});
