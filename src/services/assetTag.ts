import { prisma } from "@/services/prisma";

/**
 * Asset tags (AF-0001, AF-0002, ...) come from a database sequence, so any
 * number of requests creating assets at the same moment each get their own
 * number. The old way (read the highest tag, add one) handed the same number to
 * every simultaneous request, and compared tags as text, which puts AF-9999
 * after AF-10000.
 */
const SEQUENCE = "asset_tag_seq";

export const formatAssetTag = (n: number | bigint) => `AF-${String(n).padStart(4, "0")}`;

/** The next unused number. Gaps are fine (a failed create still uses one). */
export async function nextAssetTag(): Promise<string> {
  const rows = await prisma.$queryRaw<{ n: bigint }[]>`SELECT nextval('asset_tag_seq') AS n`;
  return formatAssetTag(rows[0].n);
}

/**
 * Moves the sequence past every existing AF- tag. Needed when assets were
 * inserted with chosen tags (seed data, imports). Never moves it backwards.
 */
export async function syncAssetTagSequence(): Promise<void> {
  await prisma.$queryRawUnsafe(`
    SELECT setval('${SEQUENCE}', GREATEST(
      COALESCE((SELECT max(substring("assetTag" from 4)::bigint) FROM "Asset" WHERE "assetTag" ~ '^AF-[0-9]+$'), 0),
      (SELECT last_value FROM ${SEQUENCE})
    ), true)
  `);
}
