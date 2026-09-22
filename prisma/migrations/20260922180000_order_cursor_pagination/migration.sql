-- Additive keyset-pagination index for the global order history.
--
-- No business rows are rewritten. SQLite scans the populated table to build
-- this index and serializes writers during DDL; deploy in a low-write window.
CREATE INDEX "Order_orderDate_id_idx"
ON "Order"("orderDate" DESC, "id" DESC);
