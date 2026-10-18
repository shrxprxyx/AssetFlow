import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

export type Role = "ADMIN" | "ASSET_MANAGER" | "DEPARTMENT_HEAD" | "EMPLOYEE";

export type AuthUser = {
  userId: number;
  email: string;
  role: Role;
  departmentId: number | null;
};

export type GuardResult =
  | { ok: true; user: AuthUser }
  | { ok: false; response: NextResponse };

/**
 * Single entry point for API authentication + authorization.
 *
 *   const guard = await requireAuth("ADMIN", "ASSET_MANAGER");
 *   if (!guard.ok) return guard.response;
 *   const { user } = guard;
 *
 * Calling it with no roles means "any signed-in, active user".
 *
 * The role is read from the DATABASE, not the JWT. A JWT keeps its old role
 * until it expires, so trusting it would let a demoted or deactivated user
 * keep acting with their previous permissions.
 */
export async function requireAuth(...allowedRoles: Role[]): Promise<GuardResult> {
  const session = await auth();
  const id = Number(session?.user?.id);

  if (!session?.user?.id || !Number.isInteger(id) || id <= 0) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "unauthorized", message: "Sign in required" },
        { status: 401 }
      ),
    };
  }

  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, email: true, role: true, status: true, departmentId: true },
  });

  if (!user || user.status !== "ACTIVE") {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "unauthorized", message: "Account not found or inactive" },
        { status: 401 }
      ),
    };
  }

  const role = user.role as Role;

  if (allowedRoles.length > 0 && !allowedRoles.includes(role)) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "forbidden",
          message: `This action requires one of: ${allowedRoles.join(", ")}`,
        },
        { status: 403 }
      ),
    };
  }

  return {
    ok: true,
    user: { userId: user.id, email: user.email, role, departmentId: user.departmentId },
  };
}
