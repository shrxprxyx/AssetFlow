import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";
import { NextResponse } from "next/server";

const PUBLIC_PATHS = ["/login", "/signup", "/forgot-password", "/reset-password"];

// Built from the edge-safe config only: importing "@/auth" here would pull the
// database, bcrypt and Redis into middleware, which cannot run them.
const { auth } = NextAuth(authConfig);

export default auth((req) => {
  const { pathname } = req.nextUrl;
  const isLoggedIn = !!req.auth;

  // API: everything requires a session except NextAuth's own endpoints and
  // signup (both live under /api/auth/). Route handlers still do their own role
  // checks via requireAuth(); this is the safety net so a forgotten check can't
  // leave a route open to anonymous callers.
  if (pathname.startsWith("/api/")) {
    if (pathname.startsWith("/api/auth/")) return;
    if (!isLoggedIn) {
      return NextResponse.json(
        { error: "unauthorized", message: "Sign in required" },
        { status: 401 }
      );
    }
    return;
  }

  const isPublic = PUBLIC_PATHS.includes(pathname);
  if (!isLoggedIn && !isPublic) {
    return NextResponse.redirect(new URL("/login", req.url));
  }
});

// /api is now INCLUDED in the matcher (it used to be excluded).
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
