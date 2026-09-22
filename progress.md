# Financial integrity progress

Updated 2026-09-22. This is the review and handoff summary for the active PR stack.

## Current architecture

Meridian is a single-company billing system backed by one company-owned database. `Customer` is the bill-to entity, `Product` is a global catalog item, and `Rate` is the customer-specific commercial relationship between a Customer and Product; there is no organization, workspace, or tenant ownership boundary.

Authentication uses global opaque operator API keys with `ADMIN`, `BILLING`, and `VIEWER` roles. Audit evidence, idempotency, pagination, reporting, and the singleton accounting close are global, while financial invariants continue to require orders, invoices, payments, applications, and reversals to reference the correct Customer.

## Completed

- Adopted Bun, TypeScript 7, a single lockfile, Oxlint, CI, architecture ratchets, and direct `bun run <command>` scripts.
- Centralized API request/response models in Zod and derived TypeScript types from those runtime contracts. Prisma remains the generated persistence type source.
- Added Decimal-backed financial columns and exact decimal-string API boundaries, with deterministic BigInt pricing and temporary legacy float compatibility only during expand/backfill/contract rollout.
- Materialized immutable product, rate, pricing, customer, invoice-line, and commercial provenance snapshots so historical invoices do not read mutable live catalog data.
- Added exact payment allocation/reversal rules, closed-period enforcement, append-only ledger protections, reconciliation, and concurrency/CAS coverage.
- Added strict API input/output validation, Problem Details, request correlation, redacted telemetry, email validation, idempotency, strong ETags, bounded keyset pagination, generated OpenAPI 3.1, and a validated browser SDK.
- Preserved existing clients while deprecating historical partial-update PUT operations and publishing PATCH for new partial updates where implemented.
- Added global operator-key bootstrap and authenticated administration. The first key is created with `bun run operator:key:bootstrap -- --name <name>`; routine issuance/revocation uses the authenticated `/api/v1/operator-api-keys` API.
- Replaced the mistaken unreleased ownership split in full: schema, migrations, backfills, preflights, route contracts, cursor scoping, audit/idempotency fields, generated clients, and test fixtures now match the single-company model.
- Added behavioral unit, HTTP, migration, seeded-database, concurrency, replay, rollback, stale-writer, and failure-mode coverage instead of implementation-mirroring assertions.

## Verification

- `bun run check`: passes Oxlint, server/client TypeScript, architecture rules, and generated OpenAPI drift checks.
- `bun test`: 253 passing, 0 failing across 76 files, including disposable migrated SQLite databases and loopback HTTP scenarios.
- `DATABASE_URL=file:./dev.db bun run db:validate`: Prisma schema valid.
- `bun run --cwd client build`: production client build passes.
- `git diff --check`: clean.

The bootstrap CLI received an additional focused test after the full-suite run; both bootstrap tests pass and the complete static check remains green.

## Active review stack

Review bottom to top. PRs #8-#13 were closed because they encoded the incorrect ownership assumption; their valid net work is retained in the corrected capstone.

| Order | PR | Scope | Current local/remote evidence |
| ---: | --- | --- | --- |
| 1 | [#1](https://github.com/wpalmeri/codebase-walkthrough-interview/pull/1) | Bun, TypeScript 7, Oxlint, CI | CI green |
| 2 | [#2](https://github.com/wpalmeri/codebase-walkthrough-interview/pull/2) | Zod model contracts and pricing foundations | CI green |
| 3 | [#3](https://github.com/wpalmeri/codebase-walkthrough-interview/pull/3) | Decimal schema and exact API representations | CI green |
| 4 | [#4](https://github.com/wpalmeri/codebase-walkthrough-interview/pull/4) | Ledger exactness and payment allocation | CI green |
| 5 | [#5](https://github.com/wpalmeri/codebase-walkthrough-interview/pull/5) | Immutable snapshots, HTTP behavior, authentication | CI green |
| 6 | [#6](https://github.com/wpalmeri/codebase-walkthrough-interview/pull/6) | Safe backfills and mutation idempotency | CI green |
| 7 | [#7](https://github.com/wpalmeri/codebase-walkthrough-interview/pull/7) | Reconciliation and migration/architecture guardrails | CI green |
| 8 | [#15](https://github.com/wpalmeri/codebase-walkthrough-interview/pull/15) | Corrected single-company API, audit, concurrency, OpenAPI, SDK, and test capstone | CI green |

## Remaining work, ranked

1. **P0 — Prove live financial cutover readiness.** Run every dry-run backfill and bounded reconciliation against each deployment, retain evidence for irreducible rows, then ship separate rehearsed contract migrations that make Decimal/snapshot fields required and finally retire float reads/writes. Do not scan or rewrite production rows in deploy migrations.
2. **P0 — Add interactive staff authentication.** Replace the browser development path with authorization-code/PKCE sessions, CSRF protection, rotation/logout, and role-change tests. Keep operator API keys out of browser JavaScript and document pepper storage, rotation, and recovery.
3. **P1 — Finish additive REST evolution.** Add canonical read resources and `Location` headers, finish PATCH coverage before deprecating remaining historical partial PUT usage, and keep current v1 aliases/statuses until measured client adoption permits a versioned cleanup.
4. **P1 — Operationalize controls.** Schedule read-only bounded reconciliation, export metrics/alerts, produce an SBOM, and rehearse final-admin, key/pepper rotation, accounting-close, restore, and rollback procedures.
5. **P1 — Build durable delivery.** Implement the outbox, retries, provider callbacks, delivery-state reconciliation, immutable artifact storage, customer webhooks, and reminder/dunning policy described in `whatsnext.md`.
6. **P2 — Prepare the target database.** Add PostgreSQL-specific NUMERIC validation, concurrent indexes, lock/timeout guidance, and database-native aggregation only after the target schema and deployment path are proven. SQLite migration behavior must not be presented as online PostgreSQL behavior.

## Review notes

- Migration files are one-per-change under `prisma/migrations/`; the migration README documents expand/backfill/reconcile/contract sequencing, lock behavior, and rollback expectations.
- `README.md` and `report.md` are user-owned and intentionally excluded from these commits.
- `plan.md` is the implementation ledger, `worklog.md` records delivered changes, and `whatsnext.md` owns intentionally deferred external delivery work.
