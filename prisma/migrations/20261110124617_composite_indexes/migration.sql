-- CreateIndex
CREATE INDEX "ActivityLog_actorId_timestamp_idx" ON "ActivityLog"("actorId", "timestamp");

-- CreateIndex
CREATE INDEX "Allocation_assetId_status_idx" ON "Allocation"("assetId", "status");

-- CreateIndex
CREATE INDEX "ResourceBooking_resourceId_startTime_endTime_idx" ON "ResourceBooking"("resourceId", "startTime", "endTime");
