import type { NextAuthConfig } from "next-auth";

/**
 * The part of the NextAuth setup that is safe to run in proxy.ts.
 *
 * The proxy sits in front of every request, so it must not pull in the database,
 * bcrypt or Redis. It only needs to read the session cookie, which needs no
 * providers. `auth.ts` adds the Credentials provider (database + password
 * check + rate limiting) on top of this for the API routes.
 */
export const authConfig = {
  // Short sessions: a stolen cookie stops working within a day even if never revoked.
  // (Revoking sooner: bump User.sessionVersion, see services/guards.ts.)
  session: { strategy: "jwt", maxAge: 8 * 60 * 60 },
  pages: { signIn: "/login" },
  providers: [],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.role = user.role;
        token.departmentId = user.departmentId;
        token.id = user.id;
        token.sessionVersion = user.sessionVersion;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.role = token.role as string;
        session.user.departmentId = token.departmentId as number | null;
        // Sessions issued before this existed have no version: they count as 0.
        session.user.sessionVersion = (token.sessionVersion as number | undefined) ?? 0;
      }
      return session;
    },
  },
} satisfies NextAuthConfig;
