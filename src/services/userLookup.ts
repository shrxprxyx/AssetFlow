import { prisma } from "./prisma";

/** How emails are stored: no surrounding spaces, all lowercase. */
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/**
 * Finds an account by email, ignoring letter case.
 *
 * Older accounts may have been created with capital letters (e.g. "Priya@X.com"),
 * so a plain lookup of the lowercased address would lock them out. Matching
 * case-insensitively finds both old and new accounts.
 */
export function findUserByEmail(email: string) {
  return prisma.user.findFirst({
    where: { email: { equals: email.trim(), mode: "insensitive" } },
    orderBy: { id: "asc" },
  });
}