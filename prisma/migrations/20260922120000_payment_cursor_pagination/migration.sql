-- Additive keyset-pagination index for tenant-scoped payment lists.
--
-- No business rows are rewritten. SQLite must scan the existing Payment table
-- while building this index and serializes writers for DDL; apply during a
-- controlled low-write window and monitor migration duration.
CREATE INDEX "Payment_tenantId_receivedAt_id_idx"
ON "Payment"("tenantId", "receivedAt" DESC, "id" DESC);
