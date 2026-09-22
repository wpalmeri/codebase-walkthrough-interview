import {
  CloseAccountingPeriodBodySchema,
  CloseAccountingPeriodResponseSchema,
  InvoiceStatusSchema,
  type CloseAccountingPeriodResponse,
} from "@meridian/contracts";
import { prisma } from "../db";
import { appendRequestAuditEvent, RequestAuditMetadataSchema, type RequestAuditAppender, type RequestAuditMetadata } from "../audit/requestAudit";
import type { Principal } from "../auth/principal";
import { compareAccountingDates, parseAccountingDate } from "../domain/accountingPeriod";
import { AuthorizationError, ConflictError, NotFoundError, PreconditionError } from "../errors";

export class AccountingPeriodCloseError extends Error {
  constructor(
    readonly code:
      | "ADMIN_TENANT_API_KEY_REQUIRED"
      | "ACTING_KEY_NOT_ACTIVE"
      | "TENANT_NOT_FOUND"
      | "AUDIT_IDENTITY_MISMATCH"
      | "CLOSE_MOVES_BACKWARD"
      | "FINALIZED_INVOICE_ACCOUNTING_DATE_MISSING"
      | "CONCURRENT_ACCOUNTING_PERIOD_CLOSE"
  ) {
    super(code);
    this.name = "AccountingPeriodCloseError";
  }
}

type AccountingControlRow = { readonly id: string; readonly tenantId: string; readonly closedThroughDate: string | null };
const invoiceStatus = InvoiceStatusSchema.enum;
const finalizedInvoiceStatuses = [invoiceStatus.POSTED, invoiceStatus.SENT, invoiceStatus.PAID] as const;
type FinalizedInvoiceStatus = (typeof finalizedInvoiceStatuses)[number];
const closeState = CloseAccountingPeriodResponseSchema.shape.state.enum;

/** Narrow interface shared by PrismaClient and interactive transactions. */
export interface AccountingPeriodCloseTransaction {
  readonly tenant: { findUnique(input: { readonly where: { readonly id: string }; readonly select: { readonly id: true } }): Promise<{ readonly id: string } | null> };
  readonly tenantApiKey: { findFirst(input: { readonly where: { readonly id: string; readonly tenantId: string; readonly role: "ADMIN"; readonly revokedAt: null }; readonly select: { readonly id: true } }): Promise<{ readonly id: string } | null> };
  readonly invoice: { findFirst(input: { readonly where: { readonly tenantId: string; readonly status: { readonly in: readonly FinalizedInvoiceStatus[] }; readonly accountingDate: null }; readonly select: { readonly id: true } }): Promise<{ readonly id: string } | null> };
  readonly tenantAccountingPeriodControl: {
    findUnique(input: { readonly where: { readonly tenantId: string }; readonly select: { readonly id: true; readonly tenantId: true; readonly closedThroughDate: true } }): Promise<AccountingControlRow | null>;
    create(input: { readonly data: { readonly tenantId: string; readonly closedThroughDate: string }; readonly select: { readonly id: true; readonly tenantId: true; readonly closedThroughDate: true } }): Promise<AccountingControlRow>;
    update(input: { readonly where: { readonly id: string }; readonly data: { readonly closedThroughDate: string }; readonly select: { readonly id: true; readonly tenantId: true; readonly closedThroughDate: true } }): Promise<AccountingControlRow>;
  };
  readonly auditEvent: { create(input: { readonly data: unknown }): Promise<unknown> };
}

export interface AccountingPeriodCloseStore {
  $transaction<T>(operation: (transaction: AccountingPeriodCloseTransaction) => Promise<T>): Promise<T>;
}

const store: AccountingPeriodCloseStore = {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the public interface deliberately exposes only delegates available on an interactive transaction.
  $transaction: (operation) => prisma.$transaction((transaction) => operation(transaction as unknown as AccountingPeriodCloseTransaction)),
};

export type CloseAccountingPeriodOptions = {
  readonly appendAudit?: RequestAuditAppender;
  readonly now?: () => Date;
};

function requireTenantApiKeyAdmin(principal: Principal): Principal {
  if (principal.kind !== "TENANT_API_KEY" || principal.role !== "ADMIN") {
    throw new AccountingPeriodCloseError("ADMIN_TENANT_API_KEY_REQUIRED");
  }
  return principal;
}

function verifyAuditIdentity(metadata: RequestAuditMetadata, principal: Principal): void {
  if (
    metadata.tenantId !== principal.tenantId ||
    metadata.principal.kind !== principal.kind ||
    metadata.principal.subjectId !== principal.subjectId ||
    metadata.principal.credentialId !== principal.credentialId
  ) throw new AccountingPeriodCloseError("AUDIT_IDENTITY_MISMATCH");
}

function isRetryableCloseRace(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  // SQLite can surface a competing control creation as P2002 and a write lock
  // as P2034/SQLITE_BUSY. Retrying rereads the now-authoritative control row.
  return code === "P2002" || code === "P2034" || ("message" in error && typeof error.message === "string" && /SQLITE_BUSY|database is locked/u.test(error.message));
}

/** Creates or monotonically advances one tenant control and its audit row atomically. */
export async function closeAccountingPeriod(
  suppliedStore: AccountingPeriodCloseStore,
  principal: Principal,
  input: unknown,
  metadata: RequestAuditMetadata,
  options: CloseAccountingPeriodOptions = {}
): Promise<CloseAccountingPeriodResponse> {
  const actor = requireTenantApiKeyAdmin(principal);
  const requested = parseAccountingDate(CloseAccountingPeriodBodySchema.parse(input).closedThroughDate);
  const audited = RequestAuditMetadataSchema.parse(metadata);
  verifyAuditIdentity(audited, actor);
  const appendAudit = options.appendAudit ?? appendRequestAuditEvent;

  const run = () => suppliedStore.$transaction(async (transaction) => {
    // The tenant and acting key are both checked after the transaction begins;
    // edge authentication is intentionally not sufficient for this mutation.
    if ((await transaction.tenant.findUnique({ where: { id: actor.tenantId }, select: { id: true } })) === null) {
      throw new AccountingPeriodCloseError("TENANT_NOT_FOUND");
    }
    if ((await transaction.tenantApiKey.findFirst({
      where: { id: actor.credentialId, tenantId: actor.tenantId, role: "ADMIN", revokedAt: null },
      select: { id: true },
    })) === null) throw new AccountingPeriodCloseError("ACTING_KEY_NOT_ACTIVE");

    const existing = await transaction.tenantAccountingPeriodControl.findUnique({
      where: { tenantId: actor.tenantId },
      select: { id: true, tenantId: true, closedThroughDate: true },
    });
    if (existing !== null && existing.closedThroughDate !== null) {
      const comparison = compareAccountingDates(requested, parseAccountingDate(existing.closedThroughDate));
      if (comparison < 0) throw new AccountingPeriodCloseError("CLOSE_MOVES_BACKWARD");
      if (comparison === 0) return CloseAccountingPeriodResponseSchema.parse({ state: closeState.ALREADY_CLOSED, closedThroughDate: requested });
    }

    // This is a tenant-bounded readiness gate, not a global reconciliation scan.
    if ((await transaction.invoice.findFirst({
      where: { tenantId: actor.tenantId, status: { in: finalizedInvoiceStatuses }, accountingDate: null },
      select: { id: true },
    })) !== null) throw new AccountingPeriodCloseError("FINALIZED_INVOICE_ACCOUNTING_DATE_MISSING");

    const control = existing === null
      ? await transaction.tenantAccountingPeriodControl.create({
          data: { tenantId: actor.tenantId, closedThroughDate: requested },
          select: { id: true, tenantId: true, closedThroughDate: true },
        })
      : await transaction.tenantAccountingPeriodControl.update({
          where: { id: existing.id }, data: { closedThroughDate: requested },
          select: { id: true, tenantId: true, closedThroughDate: true },
        });
    await appendAudit(transaction, audited, {
      action: "ACCOUNTING_PERIOD_CLOSED",
      resourceKind: "ACCOUNTING_PERIOD_CONTROL",
      resourceId: control.id,
    }, { now: options.now });
    return CloseAccountingPeriodResponseSchema.parse({ state: closeState.CLOSED, closedThroughDate: requested });
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!isRetryableCloseRace(error) || attempt === 1) {
        if (isRetryableCloseRace(error)) throw new AccountingPeriodCloseError("CONCURRENT_ACCOUNTING_PERIOD_CLOSE");
        throw error;
      }
    }
  }
  throw new AccountingPeriodCloseError("CONCURRENT_ACCOUNTING_PERIOD_CLOSE");
}

export async function closeAccountingPeriodForRequest(
  principal: Principal,
  body: unknown,
  metadata: RequestAuditMetadata
): Promise<CloseAccountingPeriodResponse> {
  try {
    return await closeAccountingPeriod(store, principal, body, metadata);
  } catch (error) {
    if (!(error instanceof AccountingPeriodCloseError)) throw error;
    switch (error.code) {
      case "TENANT_NOT_FOUND":
        throw new NotFoundError("TENANT_NOT_FOUND", "Tenant was not found");
      case "CLOSE_MOVES_BACKWARD":
        throw new ConflictError("ACCOUNTING_PERIOD_CLOSE_MOVES_BACKWARD", "Accounting periods can only close forward");
      case "FINALIZED_INVOICE_ACCOUNTING_DATE_MISSING":
        throw new PreconditionError("FINALIZED_INVOICE_ACCOUNTING_DATE_MISSING", "Finalized invoice accounting dates must be backfilled before closing");
      case "ADMIN_TENANT_API_KEY_REQUIRED":
      case "ACTING_KEY_NOT_ACTIVE":
      case "AUDIT_IDENTITY_MISMATCH":
        throw new AuthorizationError();
      case "CONCURRENT_ACCOUNTING_PERIOD_CLOSE":
        throw new ConflictError("CONCURRENT_ACCOUNTING_PERIOD_CLOSE", "A competing accounting-period close must be retried");
    }
    throw error;
  }
}
