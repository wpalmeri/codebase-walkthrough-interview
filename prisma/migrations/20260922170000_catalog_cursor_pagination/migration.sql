-- Additive keyset-pagination indexes for tenant-scoped catalog lists.
--
-- No business rows are rewritten. SQLite scans each populated table to build
-- an index and serializes writers during DDL, so apply in a low-write window.
CREATE INDEX "Customer_tenantId_name_id_idx"
ON "Customer"("tenantId", "name", "id");

CREATE INDEX "Product_tenantId_sku_id_idx"
ON "Product"("tenantId", "sku", "id");
