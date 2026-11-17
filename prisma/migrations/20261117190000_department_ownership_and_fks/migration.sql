-- Department ownership of assets, and foreign keys that were missing.
--
-- Before adding a key, check that no row already points at something that does
-- not exist. If any do, stop with a clear message instead of rewriting history:
-- fix or remove those rows, then run `prisma migrate deploy` again.
DO $$
DECLARE
  n_actor integer;
  n_tech integer;
  n_dept integer;
  n_log integer;
BEGIN
  SELECT count(*) INTO n_actor FROM "AssetHistory" h
    WHERE NOT EXISTS (SELECT 1 FROM "User" u WHERE u.id = h."actorId");
  SELECT count(*) INTO n_tech FROM "MaintenanceRequest" m
    WHERE m."technicianId" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u.id = m."technicianId");
  SELECT count(*) INTO n_dept FROM "Allocation" a
    WHERE a."holderDeptId" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "Department" d WHERE d.id = a."holderDeptId");
  SELECT count(*) INTO n_log FROM "Notification" n
    WHERE n."activityLogId" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "ActivityLog" l WHERE l.id = n."activityLogId");

  IF n_actor + n_tech + n_dept + n_log > 0 THEN
    RAISE EXCEPTION
      'Cannot add foreign keys: % AssetHistory rows with an unknown actorId, % MaintenanceRequest rows with an unknown technicianId, % Allocation rows with an unknown holderDeptId, % Notification rows with an unknown activityLogId. Fix those rows and run the migration again.',
      n_actor, n_tech, n_dept, n_log;
  END IF;
END $$;

-- AlterTable
ALTER TABLE "Asset" ADD COLUMN "departmentId" INTEGER;

-- CreateIndex
CREATE INDEX "Asset_departmentId_idx" ON "Asset"("departmentId");

-- CreateIndex
CREATE INDEX "AssetHistory_actorId_idx" ON "AssetHistory"("actorId");

-- CreateIndex
CREATE INDEX "Allocation_holderDeptId_idx" ON "Allocation"("holderDeptId");

-- CreateIndex
CREATE INDEX "MaintenanceRequest_technicianId_idx" ON "MaintenanceRequest"("technicianId");

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetHistory" ADD CONSTRAINT "AssetHistory_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Allocation" ADD CONSTRAINT "Allocation_holderDeptId_fkey" FOREIGN KEY ("holderDeptId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceRequest" ADD CONSTRAINT "MaintenanceRequest_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_activityLogId_fkey" FOREIGN KEY ("activityLogId") REFERENCES "ActivityLog"("id") ON DELETE SET NULL ON UPDATE CASCADE;
