-- Expand-only Customer delivery-address backstop.
--
-- These triggers inspect only newly inserted addresses or updates that name the
-- email column. They do not scan, rewrite, or reject untouched legacy rows;
-- the shared Zod contract remains the authoritative mailbox parser at the API
-- and delivery boundaries.
CREATE TRIGGER "Customer_email_insert_guard"
BEFORE INSERT ON "Customer"
WHEN
  length(NEW."email") NOT BETWEEN 3 AND 254
  OR NEW."email" <> trim(NEW."email")
  OR instr(NEW."email", ' ') > 0
  OR instr(NEW."email", char(9)) > 0
  OR instr(NEW."email", char(10)) > 0
  OR instr(NEW."email", char(13)) > 0
  OR length(NEW."email") - length(replace(NEW."email", '@', '')) <> 1
  OR instr(NEW."email", '@') <= 1
  OR instr(NEW."email", '@') - 1 > 64
  OR instr(NEW."email", '@') >= length(NEW."email")
  OR substr(NEW."email", 1, 1) = '.'
  OR substr(NEW."email", instr(NEW."email", '@') - 1, 1) = '.'
  OR instr(NEW."email", '..') > 0
  OR instr(substr(NEW."email", instr(NEW."email", '@') + 1), '.') <= 1
  OR substr(NEW."email", -1, 1) = '.'
BEGIN
  SELECT RAISE(ABORT, 'Customer.email is not a structurally valid delivery address');
END;

CREATE TRIGGER "Customer_email_update_guard"
BEFORE UPDATE OF "email" ON "Customer"
WHEN
  length(NEW."email") NOT BETWEEN 3 AND 254
  OR NEW."email" <> trim(NEW."email")
  OR instr(NEW."email", ' ') > 0
  OR instr(NEW."email", char(9)) > 0
  OR instr(NEW."email", char(10)) > 0
  OR instr(NEW."email", char(13)) > 0
  OR length(NEW."email") - length(replace(NEW."email", '@', '')) <> 1
  OR instr(NEW."email", '@') <= 1
  OR instr(NEW."email", '@') - 1 > 64
  OR instr(NEW."email", '@') >= length(NEW."email")
  OR substr(NEW."email", 1, 1) = '.'
  OR substr(NEW."email", instr(NEW."email", '@') - 1, 1) = '.'
  OR instr(NEW."email", '..') > 0
  OR instr(substr(NEW."email", instr(NEW."email", '@') + 1), '.') <= 1
  OR substr(NEW."email", -1, 1) = '.'
BEGIN
  SELECT RAISE(ABORT, 'Customer.email is not a structurally valid delivery address');
END;
