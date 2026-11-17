-- Audit module: location scope, one finding per asset per cycle, discrepancy resolution.

-- LOCATION-scoped cycles audit the assets whose location contains this text.
ALTER TABLE "AuditCycle" ADD COLUMN "scopeLocation" TEXT;

-- Who decided on a discrepancy, when, and why.
ALTER TABLE "AuditFinding"
  ADD COLUMN "resolvedBy" INTEGER,
  ADD COLUMN "resolvedAt" TIMESTAMP(3),
  ADD COLUMN "resolutionNotes" TEXT;

-- (cycleId, assetId) was never enforced, so duplicates may exist. Keep the newest.
DELETE FROM "AuditFinding" a
USING "AuditFinding" b
WHERE a."cycleId" = b."cycleId" AND a."assetId" = b."assetId" AND a."id" < b."id";

CREATE UNIQUE INDEX "AuditFinding_cycleId_assetId_key" ON "AuditFinding"("cycleId", "assetId");

-- Until now "the auditor" was whoever was signed in. Cycles that are still open
-- keep working: their creator becomes the assigned auditor.
INSERT INTO "AuditAssignment" ("cycleId", "auditorId")
SELECT "id", "createdBy" FROM "AuditCycle" WHERE "status" = 'ACTIVE'
ON CONFLICT ("cycleId", "auditorId") DO NOTHING;
