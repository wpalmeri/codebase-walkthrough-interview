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
- [x] Add request correlation and strictly redacted structured error events (`97c3363`).
- [x] Add v1 Rate strong ETags, exact conditional writes, legacy invalidation, and ETag-safe idempotent replay (`ea35b16`).
- [x] Extend v1 strong ETags and exact conditional writes to Order and Invoice aggregates, including indirect child/evidence invalidation and stale-writer tests (`400b451`, `ec43053`).
- [x] Add a strict shared cursor/page contract and integrate global v1 Payment, Customer, Product, Order, and Invoice pagination without changing legacy arrays (`5052272`, `861a9cb`, `4e4bd4f`, `375e89e`, `3f9a0f9`).
- [x] Remove destination PII and commercial identifiers from delivery operational telemetry (`b43fd2b`).
- [x] Bound recipient addresses in shared Zod contracts and add expand-only database backstops that do not reject untouched invalid history (`e29c920`, `3c145b8`).
- [x] Define one Zod/OpenAPI operation contract and adopt it for every v1 route family, including Invoice (`9d9790d`, `d4bc9b0`, `482879c`, `7288959`, `b0f0327`, `91c7020`).
- [x] Publish the complete deterministic OpenAPI 3.1 document and generated TypeScript shapes with a CI drift check (`b5329ed`).
- [x] Validate every current browser success payload through shared Zod contracts without leaking malformed response data (`c7ef0cb`).
- [x] Split browser-safe schemas from Node-only cursor signing so client validation does not bundle server crypto (`e15b502`).
- [x] Bound JSON bodies, publish real correlation/authentication/pagination headers, and keep idempotency failures redacted and representation-safe (`6fe74e9`).
- [x] Add a generated-contract-bound v1 SDK with exact status typing, exhaustive Zod output validation, pagination/ETag metadata, and normalized failure results (`eb72a8a`).
- [x] Append request-derived audit evidence atomically for Rate, combo-discount, Order, Invoice, delivery, payment receipt, allocation, and reversal mutations (`ddf6424`, `d5532b1`, `c2406cf`).
- [x] Replace unbounded report loading with date/status-filtered, fixed-size keyset scans and exact decimal reduction (`52a8e1c`).
- [x] Preserve historical customer identity in revenue reports through immutable invoice snapshots with an explicit legacy-null fallback (`1a7d922`).

### Global operator controls and runtime operations

- [x] Model the deployment as one company-owned billing database: Customers are bill-to entities, Products are global, and Rates join a Customer to a Product.
- [x] Authenticate opaque global operator API keys with least-privilege `ADMIN`, `BILLING`, and `VIEWER` roles; callers never provide an ownership scope.
- [x] Scope idempotency to the authenticated credential and normalized operation, and record global append-only audit evidence for financial mutations.
- [x] Add one-time-secret operator key bootstrap plus authenticated ADMIN issuance/revocation with transaction-coupled audit and final-admin database guards.
- [x] Add a singleton accounting close with monotonic concurrency, transaction-coupled audit evidence, and database-enforced closed-period rules.
- [x] Add public liveness, redacted readiness, and bounded graceful shutdown behavior (`492ddd1`).

### Migrations, backfills, and test infrastructure

- [x] Add the reusable bounded/checkpointed/dry-run-first financial backfill engine (`9b155f8`).
- [x] Backfill invoice exact values/accounting dates safely (`0f49b3c`).
- [x] Backfill legacy catalog, tier, discount, payment, and application exact fields safely (`5d6c3db`).
- [x] Seed a fresh migrated database with fully reconciled exact financial scenarios (`f88bcc7`).
- [x] Make production migrations the only supported setup/reset path (`20a23f9`).
- [x] Add pinned PostgreSQL contract coverage for native NUMERIC, constraints, locking, and serializable failure (`07f4318`).
- [x] Backfill order pricing and invoice identity snapshots only from immutable persisted evidence (`4620816`, `57dd259`).
- [x] Add a bounded, read-only financial reconciliation gate with deterministic issue contracts (`c59ed50`).
- [x] Add an expand-only resource-version migration and strict strong-ETag/`If-Match` primitives (`fb4eda4`).
- [x] Add trigger-only Order and Invoice aggregate-version migrations and measured global catalog pagination indexes (`400b451`, `ec43053`, `4e4bd4f`).
- [x] Add measured global Order and Invoice pagination indexes with explicit SQLite writer-blocking deployment guidance (`375e89e`, `3f9a0f9`).
- [x] Guard changed Customer emails at the database boundary without scanning or rewriting historical rows (`3c145b8`).
- [x] Add an empty-table append-only audit migration with generated enum vocabulary, authenticated actor evidence, valid action/resource pairs, immutable rows, and an expand-safe insert guard (`8a393ca`, `25a1528`).
- [x] Move Prisma's seed configuration into typed `prisma.config.ts` while keeping the database URL external (`813d3d9`).
- [x] Remove the mistaken, unreleased ownership expansion, its backfills/preflights, and all ownership-scoped indexes, guards, contracts, and fixtures without changing customer identity or financial history.

### Continuous enforcement and supply chain

- [x] Ratchet architectural integrity against new float-backed finance fields, raw financial coercion, direct ledger mutations, and hand-written API model types (`478ddca`).
- [x] Replace raw Prisma lifecycle field types with generated enums and prevent regressions through the architecture ratchet (`c34bae7`).
- [x] Derive remaining production lifecycle and method values from shared Zod or generated Prisma enums and reject new raw literals (`bef142b`).
- [x] Reject destructive, scan-coupled, or malformed deploy migrations through the architecture ratchet (`e307053`).
- [x] Upgrade and pin vulnerable runtime/tooling dependencies and verify a zero-finding live audit (`0fce620`).

## Ranked remaining implementation sequence

1. **P0 — Contract historical financial fields after deployment evidence is clean**
   - Run the implemented dry-run backfills and bounded reconciliation against each live deployment, route irreducible rows to manual reconciliation, and retain signed operational evidence of a zero-issue full scan.
   - Only after that gate, ship separate online contract migrations that make authoritative fields required and retire float reads/writes. Never scan or rewrite production rows in deploy migrations.

2. **P0 — Complete interactive-user authentication**
   - Replace the browser's development-only unauthenticated path with an authorization-code/PKCE session flow for internal staff/operator identities; do not expose operator API keys to browser JavaScript.
   - Add CSRF/session rotation/logout/role-change tests and keep server-to-server operator API keys as a separate credential class. The identity-provider choice and deployment configuration are external prerequisites, but the server trust boundary must remain fail-closed.

3. **P1 — Operationalize credential bootstrap and recovery**
   - Treat `bun run operator:key:bootstrap -- --name <name>` as the first-key/break-glass boundary; document pepper recovery, rotation, and operator-evidence procedures. Routine issuance and revocation stay behind authenticated ADMIN endpoints.
   - Rehearse final-admin recovery and pepper rotation against a restored production snapshot before relying on the control plane operationally.

4. **P1 — Harden the published HTTP contract and client usability**
   - Mark historical partial-update `PUT` operations deprecated and direct new clients to PATCH. Reserve true replacement semantics and mandatory idempotency for an explicitly versioned v2 contract so existing clients do not break.
   - Add canonical read resources and `Location` headers before deprecating action-style mutation paths; retain current v1 statuses and aliases during adoption.
   - Keep exact reports bounded on SQLite; use database-native exact aggregation only after the target PostgreSQL schema and NUMERIC semantics are deployed and proven.

5. **P1 — Add continuous operational controls**
   - Schedule financial reconciliation in read-only bounded batches, export metrics, and alert on drift without automatically rewriting financial history.
   - Add recipient-correction semantics; delivery telemetry and audit storage are already constrained to non-PII operational metadata.
   - Produce an SBOM and document tested API-key/pepper rotation, final-admin recovery, and accounting-close recovery drills; liveness, readiness, graceful shutdown, request correlation, and redacted structured error logs are already implemented.

6. **P2 — Later protocol and architecture improvements**
   - Serve a discoverable versioned OpenAPI document if third-party integrations need runtime discovery, with an explicit compatibility and deprecation policy.
   - Introduce PostgreSQL-specific online/concurrent index and final-admin invariants rather than assuming SQLite migration SQL carries over unchanged.

## Deferred by agreement

Durable external delivery queueing, retries, provider callbacks, customer webhook subscriptions, and reminders are specified in `whatsnext.md`. They remain important, but are intentionally behind core financial integrity and behavioral database tests.
