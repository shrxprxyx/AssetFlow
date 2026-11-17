-- Run after a load test. EVERY query must return zero rows.
--
--   psql "postgresql://assetflow:assetflow@localhost:5433/assetflow_load" -f load-test/integrity-check.sql

\echo '1. assets with more than one ACTIVE allocation'
SELECT "assetId", count(*) FROM "Allocation" WHERE status = 'ACTIVE' GROUP BY "assetId" HAVING count(*) > 1;

\echo '2. overlapping bookings of the same resource'
SELECT a.id AS booking_a, b.id AS booking_b, a."resourceId"
FROM "ResourceBooking" a
JOIN "ResourceBooking" b
  ON a."resourceId" = b."resourceId" AND a.id < b.id
 AND a.status <> 'CANCELLED' AND b.status <> 'CANCELLED'
 AND tsrange(a."startTime", a."endTime", '[)') && tsrange(b."startTime", b."endTime", '[)');

\echo '3. assets marked ALLOCATED with no ACTIVE allocation'
SELECT a.id FROM "Asset" a
WHERE a.status = 'ALLOCATED'
  AND NOT EXISTS (SELECT 1 FROM "Allocation" l WHERE l."assetId" = a.id AND l.status = 'ACTIVE');

\echo '4. assets with an ACTIVE allocation that are not marked ALLOCATED'
SELECT a.id, a.status FROM "Asset" a
JOIN "Allocation" l ON l."assetId" = a.id AND l.status = 'ACTIVE'
WHERE a.status <> 'ALLOCATED';

\echo '5. duplicate audit findings for the same asset in a cycle'
SELECT "cycleId", "assetId", count(*) FROM "AuditFinding" GROUP BY "cycleId", "assetId" HAVING count(*) > 1;

\echo '6. duplicate asset tags'
SELECT "assetTag", count(*) FROM "Asset" GROUP BY "assetTag" HAVING count(*) > 1;
