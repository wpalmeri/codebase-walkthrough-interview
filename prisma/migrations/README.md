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

## Exact order-line amounts

`20260922020000_order_amount_foundation` adds a nullable `OrderItem.amountDecimal` without a default, constraint validation, or backfill. Deploy the snapshot dual-write before populating existing rows in the same bounded, restartable batches as the other order snapshots; reconcile each order's line-amount sum against its draft invoice before switching reads.

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

## Durable idempotency reservations

`20260922050000_idempotency_records` creates a new empty table and index; it does not scan or
rewrite business data. Deploy it before enabling keyed retries. Reservations deliberately fail
closed when a process dies after mutating data but before recording the response, so operators
must investigate stale `IN_PROGRESS` rows rather than deleting or replaying them automatically.
Retain completed rows for at least the published client retry window, then archive or purge them
in bounded primary-key batches under an explicit retention policy.
