# Integrity implementation plan

This is the execution source of truth. Implement each numbered item as an atomic commit, add a succinct bullet to `worklog.md`, and keep deferred external delivery work in `whatsnext.md`.

## Engineering rules

- Preserve `README.md` and `report.md` as user-owned files unless explicitly asked to edit them.
- Define API models as Zod schemas and derive TypeScript types with `z.infer`; use Prisma-generated types only for persistence records.
- Represent persisted money with Decimal and cross JSON boundaries with canonical decimal strings. Legacy floats remain only during a measured expand/backfill/contract rollout.
- Use additive migrations, bounded resumable backfills, reconciliation gates, and later contract migrations. Never combine a production table scan with the deploy migration.
- Tests must verify observable behavior, invariants, contracts, interleavings, or failure recovery—not mirror implementation details.
- Keep existing `/api` clients compatible. Add new contracts/endpoints before deprecating old ones.

## Completed atomic improvements

### Runtime contracts and exact arithmetic

- [x] Adopt Bun, TypeScript 7, Oxlint, CI, and a single workspace lockfile (`2e64b4f`).
- [x] Report only recognized, materialized invoice revenue and test period/customer aggregation (`109533a`).
- [x] Replace duplicated API model interfaces with shared Zod schemas and inferred types (`4f1924a`).
- [x] Add a deterministic bigint-backed decimal pricing engine with boundary/failure tests (`2c59808`).
- [x] Validate persisted rate tiers with the shared Zod model (`da31669`).
- [x] Declare Zod as a direct server runtime dependency (`a6bdb66`).
- [x] Add canonical Decimal persistence helpers with exact legacy fallback (`92cfd6d`).
- [x] Add exact decimal-string response contracts and Decimal-first snapshot-backed mappers (`1c5a90b`, `743489c`).
- [x] Accept exact decimal-string request inputs without breaking legacy numeric clients (`bebafc7`).
- [x] Render and aggregate exact financial values in the browser (`9b2a193`).

### Database, snapshots, and ledgers

- [x] Add the legacy baseline plus additive Decimal/snapshot/lifecycle expansion and rollout runbook (`776149f`).
- [x] Add currency fields and integrity guards, then enforce the supported USD-only policy (`abed1f9`, `8844845`).
- [x] Dual-write exact rate and discount values and persist authoritative exact order-line amounts (`6ffbd1d`, `dd4560e`).
- [x] Capture immutable order-pricing evidence and cut order/invoice reads and writes over to snapshots (`e0e2575`, `349d32c`).
- [x] Define exact payment-allocation invariants and apply payments with serializable retry/CAS semantics (`9e8f74b`, `ce9cb99`).
- [x] Freeze captured commercial provenance and make payment receipts/applications immutable and non-deletable (`444f1a8`).
- [x] Add accounting dates, closed-through control, and closed-period write guards (`d193b11`).
- [x] Add immutable partial/full payment-application reversals and make reconciliation reversal-aware (`ec77995`, `2c73eaf`).

### API and observable behavior

- [x] Validate every existing request path/query/body with strict Zod contracts (`02e9cf3`).
- [x] Validate recipients and record invoice delivery only after rendering/provider/attachment success (`d57f8b6`).
- [x] Extract the Express app boundary and test real HTTP behavior in-process (`a1b578d`).
- [x] Standardize redacted Problem Details and typed operational 404/409/412/422 failures (`f07d603`, `9919d7a`).
- [x] Add `/api/v1` and PATCH aliases while preserving the legacy contract (`602dbb9`).
- [x] Add constant-time production API-key authentication (`e43d63d`).
- [x] Add durable mutation idempotency with alias-normalized replay scope (`f5f4f03`).
- [x] Replace the fixed PDF buffer with deterministic, exact, multi-page invoice artifacts (`25b2d20`).

### Migrations, backfills, and test infrastructure

- [x] Add the reusable bounded/checkpointed/dry-run-first financial backfill engine (`9b155f8`).
- [x] Backfill invoice exact values/accounting dates safely (`0f49b3c`).
- [x] Backfill legacy catalog, tier, discount, payment, and application exact fields safely (`5d6c3db`).
- [x] Seed a fresh migrated database with fully reconciled exact financial scenarios (`f88bcc7`).
- [x] Make production migrations the only supported setup/reset path (`20a23f9`).
- [x] Add pinned PostgreSQL contract coverage for native NUMERIC, constraints, locking, and serializable failure (`07f4318`).
- [x] Backfill order pricing and invoice identity snapshots only from immutable persisted evidence (`4620816`, `57dd259`).
- [x] Add a bounded, read-only financial reconciliation gate with deterministic issue contracts (`c59ed50`).

### Continuous enforcement and supply chain

- [x] Ratchet architectural integrity against new float-backed finance fields, raw financial coercion, direct ledger mutations, and hand-written API model types (`478ddca`).
- [x] Upgrade and pin vulnerable runtime/tooling dependencies and verify a zero-finding live audit (`0fce620`).

## Ranked remaining implementation sequence

1. **P0 — Add real authorization and tenant isolation**
   - Introduce tenant/user principals, derive ownership scope from authentication, and apply it to every lookup, mutation, idempotency scope, report, and delivery action.
   - Make the browser authenticate without exposing a long-lived server API key; add cross-tenant negative tests and database defense-in-depth where practical.

2. **P0 — Contract historical financial fields after deployment evidence is clean**
   - Run the implemented dry-run backfills and bounded reconciliation against each live deployment, route irreducible rows to manual reconciliation, and retain signed operational evidence of a zero-issue full scan.
   - Only after that gate, ship separate online contract migrations that make authoritative fields required and retire float reads/writes. Never scan or rewrite production rows in deploy migrations.

3. **P1 — Strengthen API evolution and database scale**
   - Add resource versions and conditional writes with ETags/`If-Match` while retaining current endpoints.
   - Add cursor pagination, stable ordering, supporting indexes, and SQL-side report aggregation through online PostgreSQL migrations.
   - Generate OpenAPI from the Zod contracts, generate/validate the client, and add consumer-contract tests so `/api/v1` can evolve independently.
   - Replace remaining raw lifecycle strings with schema-derived enums at boundaries and explicit database constraints/types where the target database supports them.

4. **P1 — Add auditability and continuous controls**
   - Record append-only audit events for financial and lifecycle mutations using authenticated actors and correlation/idempotency identifiers.
   - Schedule reconciliation in read-only bounded batches, export metrics, and alert on drift without automatically rewriting financial history.
   - Add recipient-correction semantics and systematic PII redaction for delivery/audit logs.

5. **P2 — Operational and architecture hardening**
   - Extend the existing architecture ratchet to raw lifecycle literals and unvalidated boundary data as the remaining exceptions are removed.
   - Produce an SBOM, add structured logs/metrics/readiness/graceful shutdown, and document secret rotation and recovery drills.

## Deferred by agreement

Durable external delivery queueing, retries, provider callbacks, customer webhook subscriptions, and reminders are specified in `whatsnext.md`. They remain important, but are intentionally behind core financial integrity and behavioral database tests.
