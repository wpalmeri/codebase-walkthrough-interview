# Integrity implementation plan

This is the execution source of truth. Implement each numbered item as an atomic commit, add a succinct bullet to `worklog.md`, and keep deferred external delivery work in `whatsnext.md`.

## Engineering rules

- Preserve `README.md` and `report.md` as user-owned files unless explicitly asked to edit them.
- Define API models as Zod schemas and derive TypeScript types with `z.infer`; use Prisma-generated types only for persistence records.
- Represent persisted money with Decimal and cross JSON boundaries with canonical decimal strings. Legacy floats remain only during a measured expand/backfill/contract rollout.
- Use additive migrations, bounded resumable backfills, reconciliation gates, and later contract migrations. Never combine a production table scan with the deploy migration.
- Tests must verify observable behavior, invariants, contracts, interleavings, or failure recovery—not mirror implementation details.
- Keep existing `/api` clients compatible. Add new contracts/endpoints before deprecating old ones.

## Completed foundation

- [x] Adopt Bun, TypeScript 7, Oxlint, CI, and a single workspace lockfile (`2e64b4f`).
- [x] Report only recognized, materialized invoice revenue and test period/customer aggregation (`109533a`).
- [x] Replace duplicated API model interfaces with shared Zod schemas and inferred types (`4f1924a`).
- [x] Add a deterministic bigint-backed decimal pricing engine with boundary/failure tests (`2c59808`).
- [x] Validate persisted rate tiers with the shared Zod model (`da31669`).
- [x] Add a legacy migration baseline, additive Decimal/snapshot expansion, lifecycle guards, posted-record immutability, and safe rollout runbook (`776149f`).
- [x] Validate every existing request path/query/body with strict Zod contracts and structured 400 errors (`02e9cf3`).
- [x] Validate recipients and record invoice delivery success only after rendering/provider/attachment success (`d57f8b6`).

## Next implementation sequence

1. **Snapshot and Decimal dual-write/read cutover**
   - Make order creation capture product, rate schedule, discount inputs, quantity, effective prices, currency, and pricing version exactly once.
   - Make all order reads use snapshots rather than live rates/products.
   - Make draft invoices copy order snapshots and posted invoices freeze their own line and bill-to snapshots.
   - Dual-write legacy numeric columns temporarily; expose canonical decimal strings in additive API fields and reconcile old/new calculations before switching.

2. **Atomic order and invoice workflows**
   - Put order creation/save, draft synchronization, invoice creation, and posting into transaction-safe domain services.
   - Enforce server state transitions, item ownership, posted-order guards, compare-and-set updates, idempotent posting, and collision-safe identifiers.
   - Remove delete-and-recreate failure windows for invoice lines.

3. **Payment ledger integrity**
   - Apply payments atomically with same-customer, posted-invoice, positive amount, remaining payment, and invoice balance checks.
   - Prevent duplicate/concurrent overapplication; derive `amountPaid` from immutable applications and model corrections as reversals.
   - Add behavioral transaction and concurrency tests.

4. **Accounting period close**
   - Add an accounting-period/closed-through control and block posting, redating, or financial mutation in closed periods.
   - Store accounting dates as dates, not ambiguous timestamps, and test timezone/month boundaries plus stable report checksums.

5. **Behavioral test infrastructure**
   - Export an Express app factory and run API tests in-process.
   - Add deterministic fixtures and isolated temporary databases; use production migrations for every integration suite.
   - Add PostgreSQL CI coverage for Decimal precision, constraints, locking, transaction isolation, and interleaving failure cases while retaining SQLite only as a local demo lane.

6. **Backfill and reconciliation**
   - Implement resumable primary-key batches for Decimal and snapshot fields with checkpoints and throttling.
   - Add dry-run comparison, row/total reconciliation, mismatch stop conditions, and post-run invariant checks before switching reads.

7. **API compatibility and operational errors**
   - Map validation/not-found/conflict/precondition/domain failures to stable Problem Details responses without leaking internals.
   - Add `/api/v1`, PATCH compatibility paths, idempotency keys, versions/ETags, cursor pagination, deprecation headers, and generated OpenAPI/consumer-contract tests.

8. **Hardening and scale**
   - Add audit events and continuous financial reconciliation.
   - Add production indexes and SQL-side report aggregation through online PostgreSQL migrations.
   - Add authentication, authorization, and tenant boundaries before treating the service as internet-facing.
   - Replace the fixed-buffer mock PDF with deterministic streaming artifacts and golden rendering tests.
   - Patch audited dependencies and ratchet lint/architecture controls that prohibit floats, raw statuses, unvalidated input, and uncontrolled financial writes.

## Deferred by agreement

Durable external delivery queueing, retries, provider callbacks, customer webhook subscriptions, and reminders are specified in `whatsnext.md`. They remain important, but are intentionally behind core financial integrity and behavioral database tests.
