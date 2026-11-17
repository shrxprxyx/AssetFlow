-- Outbox: ActivityLog doubles as the list of events still to be turned into
-- notifications. processedAt is NULL until that has happened.
ALTER TABLE "ActivityLog" ADD COLUMN "processedAt" TIMESTAMP(3);
ALTER TABLE "ActivityLog" ADD COLUMN "processAttempts" INTEGER NOT NULL DEFAULT 0;

-- Everything that exists now was already handled by the old code path; do not
-- notify people about history again.
UPDATE "ActivityLog" SET "processedAt" = "timestamp";

CREATE INDEX "ActivityLog_processedAt_id_idx" ON "ActivityLog"("processedAt", "id");

-- With userId and type this makes creating a notification idempotent: processing
-- an event twice cannot notify the same person twice. Rows without an event
-- (activityLogId NULL, such as sweep notifications) are not affected, because
-- NULLs never collide in a unique index.
ALTER TABLE "Notification" ADD COLUMN "activityLogId" INTEGER;
CREATE UNIQUE INDEX "Notification_activityLogId_userId_type_key"
  ON "Notification"("activityLogId", "userId", "type");
