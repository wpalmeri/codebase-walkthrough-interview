-- Additive keyset-pagination index for tenant-scoped order lists.
--
-- No business rows are rewritten. SQLite scans the populated table to build
-- this index and serializes writers during DDL; deploy in a low-write window.
CREATE INDEX "Order_tenantId_orderDate_id_idx"
ON "Order"("tenantId", "orderDate" DESC, "id" DESC);
