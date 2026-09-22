-- Additive keyset-pagination index for tenant-scoped invoice lists.
--
-- No business rows are rewritten. SQLite scans the populated table to build
-- this index and blocks writers during DDL; apply in a controlled low-write
-- window after timing the migration on a production-sized copy.
CREATE INDEX "Invoice_tenantId_issueDate_id_idx"
ON "Invoice"("tenantId", "issueDate" DESC, "id" DESC);
