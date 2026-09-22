# Database migration runbook

The migration history begins with `20260921000000_baseline`, which exactly describes the
schema that existed before migrations were introduced. The financial-integrity migration is
an expand-only change: it adds nullable decimal and snapshot columns and adds
validation/immutability triggers without rebuilding, dropping, or scanning a table.

## Existing SQLite database

Do this during a low-write window. Substitute the actual database path and connection URL;
never run these commands against an unverified target.

1. Stop application writers and create a consistent online backup with SQLite's backup API:
   `sqlite3 /path/to/live.db ".backup '/path/to/live-before-financial-integrity.db'"`.
2. Run `PRAGMA integrity_check;`, `PRAGMA foreign_key_check;`, and verify that current values
   fit the new sets:
   `SELECT DISTINCT status FROM "Order"; SELECT DISTINCT status FROM "Invoice"; SELECT DISTINCT method, status FROM "Transmission";`.
3. Point `DATABASE_URL` at that exact database and record the pre-existing schema without
   executing it: `bunx prisma migrate resolve --applied 20260921000000_baseline`.
4. Confirm the resolved baseline with `bunx prisma migrate status`, then apply the additive
   migration with `bunx prisma migrate deploy`.
5. Repeat the integrity/foreign-key checks and restart writers. Keep the backup until
   application smoke tests pass.
6. Deploy dual writes, then backfill the new fields through an application job in small,
   restartable primary-key batches. Commit each batch separately, pause between batches when
   writers are contending, and record the last completed key so retries are idempotent. Do not
   rewrite order items tied to finalized invoices: those rows are deliberately database-locked;
   backfill their immutable invoice and invoice-line copies instead.
7. Reconcile row counts and financial totals after the job, verify that no expected decimal or
   snapshot values remain null, then switch reads to the new fields in a separate release.

`migrate resolve` is only appropriate when the target already has the exact baseline schema.
For a new empty database, run `bunx prisma migrate deploy`; Prisma will apply the baseline and every later additive migration in order.

## Currency expansion

`20260922010000_currency_foundation` adds nullable currency codes without defaults or table scans. Deploy application dual-writes before backfilling, then populate product/rate currency first, orders second, invoices third, and payments last in bounded batches. Reconcile that every invoice matches its order and every applied payment matches its invoices before making currency required in a later contract migration; database triggers reject mismatches as soon as both sides are populated.

`20260922060000_usd_currency_policy` makes the current product policy explicit: only USD may
be newly populated because the service has not implemented other currencies' minor units,
rounding, display, or settlement semantics. The migration adds guards only and leaves rollout
columns nullable, so it neither scans nor rewrites historical rows. Supporting another currency
requires an explicit currency registry and versioned rounding policy before relaxing these guards.

## Exact order-line amounts

`20260922020000_order_amount_foundation` adds a nullable `OrderItem.amountDecimal` without a default, constraint validation, or backfill. Deploy the snapshot dual-write before populating existing rows in the same bounded, restartable batches as the other order snapshots; reconcile each order's line-amount sum against its draft invoice before switching reads.

## Payment application reversals

`20260922080000_payment_application_reversals` adds a new append-only compensating-entry
table. It does not update or scan existing applications: an application must already have its
exact amount and matching payment/invoice currency facts backfilled before it can be reversed.
Each reversal records a positive DECIMAL(19,4) amount, reason, explicit open accounting date,
server-derived actor, and creation timestamp; triggers reject updates, deletes, over-reversal,
closed-period insertion, and mismatched commercial facts.

The migration also replaces only the invoice status transition trigger so a reversal can move
`PAID` back to `SENT` when a successful transmission is still evidenced, or `POSTED` otherwise.
This is a metadata-only trigger change and new-empty-table/index creation; it performs no legacy
backfill or business-table rewrite. Rehearse the transaction and rollback on a production-sized
copy, and monitor SQLite writer contention even though the deploy itself has no data scan.

## Accounting close and accounting dates

`20260922030000_accounting_close` adds a nullable `Invoice.accountingDate` (an explicit
UTC-calendar `YYYY-MM-DD` date) and the singleton `AccountingPeriodControl` row. It is a
pure expand migration: it neither infers dates from legacy timestamps nor backfills or scans
invoices. Deploy the application code that dual-writes a deliberately selected accounting date,
then backfill in small, restartable primary-key batches using a documented UTC conversion from
the legacy instant. Reconcile every finalized invoice's assigned date with the approved close
calendar before inserting or advancing `AccountingPeriodControl(id = 1).closedThroughDate`.
The database refuses to establish or advance a close while any posted, sent, or paid invoice
still lacks an accounting date.

The close boundary is inclusive and only moves forward. SQLite triggers reject malformed dates
and prevent finalized invoice inserts, posting, or redating into a closed period, while allowing
existing null dates during rollout. Do not bulk-update historical closed dates through ordinary
application credentials; handle an accounting correction through an auditable, separately
approved procedure.

## SQLite limitations and production path

SQLite permits `DECIMAL(19,4)` declarations but applies numeric affinity rather than enforcing
precision or scale. Prisma therefore exposes `Decimal`, but the database can still store a
floating representation unless the API validates canonical decimal strings. This deploy only
adds nullable columns and triggers, so it avoids the long writer lock caused by an in-migration
table scan. Every later backfill batch still briefly takes SQLite's database-wide writer lock;
measure a production-sized copy, keep batches small, and throttle on contention. A truly online
SQLite backfill is not available.

For sustained production traffic, move to PostgreSQL and use `numeric(19,4)` for money,
`numeric(19,6)` for quantities, and database enums or check constraints for lifecycle fields.
Use an expand/contract rollout: add nullable columns, deploy dual writes, backfill in bounded
primary-key batches, add constraints as `NOT VALID` and validate them separately, switch reads,
then enforce `NOT NULL` and remove legacy float columns in a later release. Build large indexes
with `CREATE INDEX CONCURRENTLY` outside a transaction, and rehearse rollback/reconciliation on
a production-sized snapshot before cutover.

For the accounting-date path on PostgreSQL, add `accounting_date date NULL` and a singleton
control table in an expand release, dual-write, and backfill in bounded primary-key batches.
Use a `CHECK` or trigger for the singleton/control semantics and serialize close/post operations
with row locks on the control row. Add date/period constraints as `NOT VALID`, validate them
separately, then make the column required only after reconciliation confirms no finalized
invoices remain null. This preserves online migration behavior and avoids a long table lock.

## Resumable backfill checkpoints

`20260922040000_backfill_checkpoints` creates an empty operational checkpoint table without
touching financial rows. Every concrete backfill writes its last successfully committed primary
key in the same transaction as that batch; dry runs never advance it. Keep checkpoint rows until
the reconciliation evidence and later contract migration are complete.

## Historical order pricing snapshots

Run `bun run db:backfill:order-pricing` in its default dry-run mode first. The
`order-pricing-snapshot-v1` job reads only `Order` and `OrderItem.pricingSnapshot`,
validates/reprices that JSON using the captured product, rate, tier, and discount terms, then fills
only missing exact and captured fields. It never joins current `Product`, `Rate`, or
`ComboDiscount` rows, because those rows may have changed after the order was accepted. The job
is primary-key-bounded, transactionally checkpointed, and throttled between batches; set
`BACKFILL_DRY_RUN=false` only after reviewing the preview.

It derives an order currency only when every validated item snapshot agrees. Investigate and
resolve typed `MISSING_PRICING_EVIDENCE`, `INVALID_PRICING_EVIDENCE`,
`CONFLICTING_PRICING_EVIDENCE`, `CONFLICTING_PERSISTED_EVIDENCE`, or
`CONFLICTING_SNAPSHOT_CURRENCY` results before retrying; never reconstruct missing history from
the live catalog or overwrite contradictory records with a best guess.

## Historical invoice identity snapshots

Run `bun run db:backfill:invoice-snapshots` in its default dry-run mode after the order-pricing and
invoice-Decimal backfills. For finalized invoices, `invoice-snapshot-v1` preserves the already
snapshotted bill-to identity and fills missing line SKU/unit fields only when each immutable
invoice line has exactly one description-plus-exact-values match to an immutable captured order
item. It never uses the current Customer, Product, Rate, or Discount state to invent issued
invoice history; missing finalized bill-to identity or ambiguous/conflicting line evidence stops
for manual reconciliation.

An unissued DRAFT invoice may fill a missing bill-to identity from its current customer because
that invoice is still mutable. The job remains primary-key-bounded, transactionally checkpointed,
throttled, restart-idempotent, and write-disabled until `BACKFILL_DRY_RUN=false` is explicit.

Run `bun run db:backfill:legacy-financial` first in its default dry-run mode. It processes
products, rates/tiers, discounts, payments, and payment applications as five independently
checkpointed primary-key streams, refusing exact/legacy disagreement or unreconciled ownership,
currency, payment-capacity, and invoice-balance facts. Set `BACKFILL_DRY_RUN=false` only after the
preview is clean; tune `BACKFILL_BATCH_SIZE` and `BACKFILL_THROTTLE_MS` for writer contention.
This job intentionally does not infer historical order pricing snapshots from current catalog
terms. Those rows require evidence-backed reconstruction or explicit manual reconciliation.

## Durable idempotency reservations

`20260922050000_idempotency_records` creates a new empty table and index; it does not scan or
rewrite business data. Deploy it before enabling keyed retries. Reservations deliberately fail
closed when a process dies after mutating data but before recording the response, so operators
must investigate stale `IN_PROGRESS` rows rather than deleting or replaying them automatically.
Retain completed rows for at least the published client retry window, then archive or purge them
in bounded primary-key batches under an explicit retention policy.

## Tenant ownership foundation

`20260922090000_tenant_foundation` is an expand-only tenancy migration. It creates empty
tenant, API-key-hash, issuer-plus-subject external-user-identity, membership, and per-tenant accounting-control
tables, then adds nullable `tenantId` columns and lookup indexes to existing customer, catalog,
order, invoice, payment, and idempotency rows. It intentionally does not populate those columns,
change existing uniqueness, or enable tenant-scoped authorization; those are separately deployed
dual-write, bounded-reconciliation, and contract releases.

The API-key table stores only a server-generated one-way digest and non-secret prefix—never a
credential plaintext—and both API keys and memberships carry a constrained least-privilege role.
The nullable SQLite columns include `REFERENCES Tenant(id)` constraints, while triggers additionally
reject mixed-tenant commercial links, tenant reassignment after ownership is established, and deletion
of a tenant that still owns business rows. Run the tenant backfill in small, checkpointed primary-key
batches, reconcile every cross-table ownership edge, and only then make `tenantId` required and
include it in idempotency uniqueness. Do not use this additive migration as permission to accept a
client-supplied tenant ID: runtime principals must be authenticated and derive the scope server-side.

## Resource versions and conditional writes

`20260922100000_resource_versions` is an expand-only optimistic-concurrency
foundation. It adds nullable integer `resourceVersion` columns to mutable root
resources only: customer, product, rate, combo discount, order, and invoice.
There is no default, backfill, table rebuild, or version-only index—the future
compare-and-swap write predicates use each table's existing primary-key index.

Deploy this before enabling any endpoint's `ETag` and `If-Match` behavior. A
bounded, restartable backfill may initialize legacy null versions in a later
release; the installed triggers accept that null-to-integer transition and then
reject non-integers, negative values, clearing, and decreases. Endpoint rollout
must atomically predicate on both resource ID and version, increment the stored
version in the same transaction, and return the new strong ETag. Do not accept
wildcard, weak, or multi-value `If-Match` headers for a mutation that needs a
single-resource compare-and-swap contract.

### Rate conditional writes and ETag replay

`20260922110000_rate_conditional_writes` adds only a nullable response-ETag
column to the empty idempotency table plus SQLite triggers on new and updated
Rate rows. It does not scan, rebuild, or rewrite existing rates. New rates are
initialized at version 1 after insertion; an older null rate remains logically
version 0 until its first business update or conditional write. The trigger
advances versions for legacy/direct business updates, while a versioned API
write advances its value in the compare-and-swap statement and therefore does
not double-increment.

Deploy this migration before exposing `/api/v1/rates/:id` ETags. Test it on a
production-sized copy because SQLite writers are serialized; although this
deploy itself is metadata plus triggers, high-rate direct catalog writes will
now perform one small additional row update. Keep the legacy `/api` write path
available during client migration. Retried idempotent writes store and replay
the exact response ETag, and their fingerprints include `If-Match`, so a stale
precondition can never silently replay a response for a different revision.

### Payment cursor pagination

`20260922120000_payment_cursor_pagination` adds one tenant-first keyset index
on `Payment(tenantId, receivedAt DESC, id DESC)`; it neither alters rows nor
rewrites table data. SQLite implements `CREATE INDEX` by scanning the table and
serializes writers while DDL runs, so schedule it in a controlled low-write
window, test duration against a production-sized copy, and monitor the writer
queue. Do not treat this migration as online/concurrent index creation.

After the index is deployed, `/api/v1/payments` may use its additive cursor
envelope. It reads `limit + 1` in descending `(receivedAt, id)` order and only
uses tenant identity derived from authentication; the opaque cursor carries
only the public customer filter fingerprint and ordering tuple. Legacy
`/api/payments` remains its existing first-100 array during client migration.

### Append-only audit events

`20260922130000_audit_events` creates a new empty `AuditEvent` table and two
tenant-first lookup indexes. It does not scan, rewrite, or alter existing
business rows, so it is safe to deploy before controller integrations begin.
The table contains only server-derived principal identity, request correlation,
resource identity, and enumerated action metadata; it has no generic request,
error, or payload field. If a request has an idempotency key, persist only its
SHA-256 fingerprint—not the key itself.

SQLite triggers reject every update and delete. Treat the table as an immutable
evidence log: correction means append a new action rather than changing history.
The new indexes are built over an empty table at first deploy; later direct
index rebuilds or table maintenance must be separately tested for SQLite's
serialized-writer behavior.

### Legacy ownership backfill

`bun run db:backfill:tenant-ownership` is preview-only by default. It reports stable ownership-conflict
codes without creating a tenant, modifying business rows, or advancing checkpoints. After an operator
reviews a clean preview, run `BACKFILL_DRY_RUN=false BACKFILL_BATCH_SIZE=100 BACKFILL_THROTTLE_MS=50
bun run db:backfill:tenant-ownership`; choose a batch size that fits the production write budget.

The write run creates or reuses exactly one `legacy-default` tenant, then processes still-null ownership
rows in separate Customer, Product, ComboDiscount, Order, Invoice, Payment, and IdempotencyRecord
primary-key stages. Each batch validates every reachable commercial ownership edge before modifying any
row, assigns only `tenantId IS NULL` rows, and persists the corresponding `BackfillCheckpoint` in the
same transaction. It can therefore be stopped and rerun without skips; do not delete checkpoints to
force a replay. It also copies the legacy singleton accounting close date to that tenant's separate
control record only if it agrees with any existing copy.

Stop and manually reconcile on any nonzero result, especially a `CONFLICTING_*_OWNERSHIP`,
`MULTIPLE_RELATED_TENANTS`, `RELATED_TO_NON_LEGACY_TENANT`, or `CONFLICTING_ACCOUNTING_CONTROL` code.
Those indicate legacy edges that cannot safely be assigned to the default tenant. Keep runtime reads
dual-compatible until the final reconciliation is clean and every new write is tenant-derived.

## Captured pricing and payment ledger immutability

`20260922070000_ledger_immutability_guards` installs row-level triggers only; it adds no
columns, defaults, indexes, scans, or table rebuilds. After an order item receives
`pricingCapturedAt`, its order/product/rate provenance and the parent order's customer/currency
cannot be repointed. Apply any unresolved order currency backfill before capturing new items;
do not bypass the guard by nulling a capture marker.

Payments and payment applications become accounting facts at the database boundary. A legacy
payment or application may receive its currently null exact decimal (and payment currency) once,
but changing an amount, party, receipt timestamp/reference, application relationship, or a
captured exact value is rejected. Neither payments nor applications can be deleted. Corrections must be modeled as
an approved reversal/adjustment workflow in a later additive release, never by mutating ledger
history.

## Read-only financial reconciliation

Run `bun run db:audit:financial` after every bounded financial backfill and before an accounting
close. It performs no writes and reports stable machine-readable issue codes for missing exact,
currency, snapshot, or accounting fields; snapshot-backed order arithmetic; invoice/payment
application totals; cross-party/currency errors; and lifecycle contradictions. The default scan
is deterministic primary-key pagination; tune `RECONCILIATION_BATCH_SIZE` and
`RECONCILIATION_MAX_BATCHES_PER_ENTITY` for a bounded production pass. A nonzero exit means
violations (or exit code 2 when the configured bound stops before all rows are scanned); never
use this audit to repair data.
