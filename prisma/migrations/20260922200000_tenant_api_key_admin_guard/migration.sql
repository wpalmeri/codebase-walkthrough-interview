-- Expand-only control-plane lockout guard. These row-scoped triggers inspect
-- only an ADMIN credential being changed or deleted; they do not scan or
-- rewrite existing tenant-key rows during deployment.
CREATE TRIGGER "TenantApiKey_retain_active_admin_update_guard"
BEFORE UPDATE OF "tenantId", "role", "revokedAt" ON "TenantApiKey"
WHEN
  OLD."role" = 'ADMIN'
  AND OLD."revokedAt" IS NULL
  AND (
    NEW."tenantId" <> OLD."tenantId"
    OR NEW."role" <> 'ADMIN'
    OR NEW."revokedAt" IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "TenantApiKey"
    WHERE
      "tenantId" = OLD."tenantId"
      AND "role" = 'ADMIN'
      AND "revokedAt" IS NULL
      AND "id" <> OLD."id"
  )
BEGIN
  SELECT RAISE(ABORT, 'tenant must retain an active ADMIN API key');
END;

CREATE TRIGGER "TenantApiKey_retain_active_admin_delete_guard"
BEFORE DELETE ON "TenantApiKey"
WHEN
  OLD."role" = 'ADMIN'
  AND OLD."revokedAt" IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "TenantApiKey"
    WHERE
      "tenantId" = OLD."tenantId"
      AND "role" = 'ADMIN'
      AND "revokedAt" IS NULL
      AND "id" <> OLD."id"
  )
BEGIN
  SELECT RAISE(ABORT, 'tenant must retain an active ADMIN API key');
END;
