-- Additive keyset-pagination index for the global invoice history.
--
-- No business rows are rewritten. SQLite scans the populated table to build
-- this index and blocks writers during DDL; apply in a controlled low-write
-- window after timing the migration on a production-sized copy.
CREATE INDEX "Invoice_issueDate_id_idx"
ON "Invoice"("issueDate" DESC, "id" DESC);
