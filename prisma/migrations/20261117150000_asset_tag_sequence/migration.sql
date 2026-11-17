-- Asset tags come from a sequence instead of "highest tag + 1", which gave the
-- same number to simultaneous requests and sorted AF-9999 after AF-10000.
CREATE SEQUENCE "asset_tag_seq";

-- Continue after the highest existing AF- tag (compared as a number).
SELECT setval(
  'asset_tag_seq',
  COALESCE((SELECT max(substring("assetTag" from 4)::bigint) FROM "Asset" WHERE "assetTag" ~ '^AF-[0-9]+$'), 0) + 1,
  false
);
