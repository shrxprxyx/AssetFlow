import { NextResponse } from "next/server";

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/** `skip` and `take` go straight into a Prisma findMany(). */
export type Page = { page: number; pageSize: number; skip: number; take: number };

export type PageResult = { ok: true; page: Page } | { ok: false; response: NextResponse };

const invalid = (field: "page" | "pageSize") =>
  NextResponse.json(
    { error: "validation_error", message: `${field} must be a positive whole number`, field },
    { status: 400 }
  );

/**
 * Reads ?page= and ?pageSize= from a list request.
 *
 *   const paging = parsePagination(new URL(req.url).searchParams);
 *   if (!paging.ok) return paging.response;
 *   const { skip, take } = paging.page;
 *
 * Missing values fall back to page 1 and DEFAULT_PAGE_SIZE. A pageSize above
 * MAX_PAGE_SIZE is capped, not rejected, so no caller can ask for the whole
 * table in one request. Anything that isn't a positive whole number is a 400.
 */
export function parsePagination(searchParams: URLSearchParams): PageResult {
  const read = (name: "page" | "pageSize", fallback: number): number | null => {
    const raw = searchParams.get(name);
    if (raw === null || raw.trim() === "") return fallback;
    if (!/^\d+$/.test(raw.trim())) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  };

  const page = read("page", 1);
  if (page === null) return { ok: false, response: invalid("page") };

  const requested = read("pageSize", DEFAULT_PAGE_SIZE);
  if (requested === null) return { ok: false, response: invalid("pageSize") };

  const pageSize = Math.min(requested, MAX_PAGE_SIZE);
  return { ok: true, page: { page, pageSize, skip: (page - 1) * pageSize, take: pageSize } };
}

/**
 * The response shape of every paginated list:
 *   { data, total, page, pageSize }
 * `total` counts every row that matches the filters, not just this page.
 * `extra` adds route-specific fields next to it (e.g. a picker list).
 */
export function paginated<T>(
  data: T[],
  total: number,
  page: Page,
  extra: Record<string, unknown> = {}
) {
  return NextResponse.json({ data, total, page: page.page, pageSize: page.pageSize, ...extra });
}
