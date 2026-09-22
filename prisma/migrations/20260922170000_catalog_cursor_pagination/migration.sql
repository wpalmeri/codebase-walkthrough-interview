-- Additive keyset-pagination indexes for global catalog lists.
--
-- No business rows are rewritten. SQLite scans each populated table to build
-- an index and serializes writers during DDL, so apply in a low-write window.
CREATE INDEX "Customer_name_id_idx"
ON "Customer"("name", "id");

CREATE INDEX "Product_sku_id_idx"
ON "Product"("sku", "id");
