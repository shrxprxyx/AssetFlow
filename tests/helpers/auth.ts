import { vi } from "vitest";
import { auth } from "@/auth";

type TestUser = { id: number; email: string; role: string; departmentId: number | null };

/** Make the next requests look like they come from this user's session. */
export function signInAs(user: TestUser, sessionRole?: string) {
  vi.mocked(auth).mockResolvedValue({
    user: {
      id: String(user.id),
      email: user.email,
      // The session (JWT) role can be stale; the guards must trust the database instead.
      role: sessionRole ?? user.role,
      departmentId: user.departmentId,
    },
    expires: "2999-01-01T00:00:00.000Z",
  } as never);
}

export function signOut() {
  vi.mocked(auth).mockResolvedValue(null as never);
}