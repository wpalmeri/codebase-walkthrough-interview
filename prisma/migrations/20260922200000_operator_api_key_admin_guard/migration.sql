-- Preserve access to the global administrative control plane. This only
-- inspects an ADMIN row being changed or deleted; it never scans/rebuilds the
-- table during deploy.
CREATE TRIGGER "OperatorApiKey_retain_active_admin_update_guard"
BEFORE UPDATE OF "role", "revokedAt" ON "OperatorApiKey"
WHEN OLD."role" = 'ADMIN'
  AND OLD."revokedAt" IS NULL
  AND (NEW."role" <> 'ADMIN' OR NEW."revokedAt" IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1 FROM "OperatorApiKey"
    WHERE "role" = 'ADMIN' AND "revokedAt" IS NULL AND "id" <> OLD."id"
  )
BEGIN
  SELECT RAISE(ABORT, 'system must retain an active ADMIN API key');
END;

CREATE TRIGGER "OperatorApiKey_retain_active_admin_delete_guard"
BEFORE DELETE ON "OperatorApiKey"
WHEN OLD."role" = 'ADMIN'
  AND OLD."revokedAt" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "OperatorApiKey"
    WHERE "role" = 'ADMIN' AND "revokedAt" IS NULL AND "id" <> OLD."id"
  )
BEGIN
  SELECT RAISE(ABORT, 'system must retain an active ADMIN API key');
END;
