-- Concurrency guarantees enforced by the database itself.
--
-- BEFORE applying, make sure your dev data doesn't already violate these rules
-- (the migration fails loudly if it does). See the pre-flight queries in the
-- instructions that came with this file.

-- 1) At most ONE active allocation per asset.
CREATE UNIQUE INDEX "allocation_one_active_per_asset"
  ON "Allocation" ("assetId")
  WHERE "status" = 'ACTIVE';

-- 2) No two non-cancelled bookings for the same resource may overlap.
--    '[)' = half-open range, so 09:00-10:00 and 10:00-11:00 are allowed.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "ResourceBooking"
  ADD CONSTRAINT "booking_valid_range" CHECK ("endTime" > "startTime");

ALTER TABLE "ResourceBooking"
  ADD CONSTRAINT "booking_no_overlap"
  EXCLUDE USING gist (
    "resourceId" WITH =,
    tsrange("startTime", "endTime", '[)') WITH &&
  )
  WHERE ("status" <> 'CANCELLED');
