# Confirmed CEO issue root causes
## Symptom	Confirmed cause
Order table and order detail show unexpected prices	Order reads recalculate against the customer’s current live rate and discounts instead of using the order-time snapshot: [orderController.ts (line 12)](/Users/wpalmeri/Documents/Github/codebase-walkthrough-interview/src/controllers/orderController.ts:12).
Invoice differs from the order	Invoice generation explicitly re-rates the order using current prices: [invoiceController.ts (line 42)](/Users/wpalmeri/Documents/Github/codebase-walkthrough-interview/src/controllers/invoiceController.ts:42).
Closed-month revenue changes	Reports ignore invoice lines and invoice.total; they recompute revenue from mutable order items. They also include drafts: [reportController.ts (line 27)](/Users/wpalmeri/Documents/Github/codebase-walkthrough-interview/src/controllers/reportController.ts:27).
Posted orders can change	The React UI disables editing, but the backend’s save operation has no posted-invoice guard: [orderController.ts (line 221)](/Users/wpalmeri/Documents/Github/codebase-walkthrough-interview/src/controllers/orderController.ts:221).
Invoices “sent” but not received	The invoice is marked SENT before PDF rendering/attachment completes. Email is declared sent synchronously with no validation, bounce, retry, or delivery confirmation: [invoiceController.ts (line 269)](/Users/wpalmeri/Documents/Github/codebase-walkthrough-interview/src/controllers/invoiceController.ts:269), [transmission.ts (line 4)](/Users/wpalmeri/Documents/Github/codebase-walkthrough-interview/src/services/transmission.ts:4).
Large invoices fail mysteriously	The PDF implementation uses a fixed 64 KiB buffer while claiming to support thousands of lines. An overflow occurs after the invoice may already have been marked sent: [pdf.ts (line 5)](/Users/wpalmeri/Documents/Github/codebase-walkthrough-interview/src/services/pdf.ts:5).


# Ranked priority list
## P0 — financial correctness and immediate containment
1. Make posted invoice snapshots the accounting source of truth.
   Reports must sum posted invoice totals/lines, never live orders or rates, and must exclude drafts and voids. Historical corrections should be credit/debit notes in an open period—not edits to prior invoices.
2. Snapshot all pricing at order time.
   Keep product/rate IDs only as provenance. Materialize product SKU/name/unit, the complete applicable rate schedule, discounts, quantity, calculated unit price, line amount, currency, and pricing version onto the order. Draft invoices copy from the order snapshot; posted invoices copy and freeze it again.
3. Enforce state transitions in the server and database.
   Current status fields are raw strings, and the backend can edit posted orders, re-post invoices, edit posted invoice dates, send drafts, or send a paid invoice and change it back to SENT. Split the overloaded invoice status into:
   - postingStatus: DRAFT | POSTED | VOIDED
   - deliveryStatus: NOT_SENT | PENDING | DELIVERED | FAILED
   - settlementStatus: UNPAID | PARTIALLY_PAID | PAID
   Use Prisma/domain enums plus database checks or triggers. Posted invoices and their source orders require database-level immutability, with comments handled by a separate endpoint.
4. Replace every financial Float.
   The schema models all prices, totals, discounts, payments, and applications as floats: [schema.prisma (line 31)](/Users/wpalmeri/Documents/Github/codebase-walkthrough-interview/prisma/schema.prisma:31).
   Recommended starting types:
   - Rate and unit price: DECIMAL(19,6)
   - Posted line/invoice/payment amounts: DECIMAL(19,2) if cents are the posting unit
   - Quantity: DECIMAL(18,6), or integer for indivisible units
   - Percentage: DECIMAL(7,4) with 0 <= value <= 100
   - Currency: ISO currency code stored on orders, invoices, and payments
   Define one explicit rounding policy. Calculate line totals first, round once at the currency boundary, and make invoice total equal the sum of rounded lines. Decimal values should cross JSON boundaries as strings, not JavaScript numbers.
5. Centralize pricing into one pure, deterministic engine.
   Almost identical tier/discount logic is copied through order creation, order reads, invoice creation, invoice syncing, invoice posting, and seeding. This guarantees drift. The current algorithm also silently leaves quantities above the final finite tier uncharged, accepts invalid tiers, and compounds every matching combo discount without a documented precedence rule.
6. Make financial workflows atomic and concurrency-safe.
   Invoice creation, draft synchronization, posting, order saves, and payment application contain multiple independent writes without a transaction. Important races include:
   - Invoice/order numbers use count + 1, so concurrent requests collide.
   - Posting deletes existing lines before recreating them.
   - Order editing can race invoice posting.
   - Payment applications can overdraw a payment or overpay an invoice.
   - Two applications can read the same amountPaid and overwrite each other.
   - A request can update an order item belonging to another order because item ownership is never checked: [orderController.ts (line 273)](/Users/wpalmeri/Documents/Github/codebase-walkthrough-interview/src/controllers/orderController.ts:273).
   Use database-generated sequences, transactions, row locking or optimistic versions, compare-and-set transitions, and idempotency keys.
7. Fix payment integrity.
   [paymentController.ts (line 43)](/Users/wpalmeri/Documents/Github/codebase-walkthrough-interview/src/controllers/paymentController.ts:43) permits negative applications, wrong-customer invoices, overapplication, duplicate applications, application to drafts, and partial commits. amountPaid can diverge from the sum of applications. Payment applications should be immutable ledger entries; corrections should be reversals.
8. Replace synchronous “send” with an outbox-backed delivery workflow.
   Within the posting/send transaction, write an immutable delivery request and payload/PDF hash. A worker then sends it with retry and idempotency. Record recipient snapshot, provider message ID, attempts, accepted/delivered/bounced/failed timestamps, and structured failure codes. Alert on stuck or bounced invoices well before they are due.
9. Validate email and delivery configuration twice.
   Validate/normalize email when the customer contact is written and revalidate at send time. Syntax validation alone is insufficient: consume provider bounces and complaints and maintain recipient health. Missing portal or clearinghouse configuration must return a domain error, not send to "unknown".
10. Add an enforceable accounting-period close.
    The code has no record of a closed period. Add an AccountingPeriod or closedThrough control, and prevent posting into, moving invoices into/out of, or mutating financial records inside a closed period. Store issue/due dates as calendar dates rather than timestamps.
## P1 — safeguards, recovery, and scale
11. Add API, domain, and database validation.
    - API: strict runtime schemas for bodies, paths, queries, and responses.
    - Domain: state-transition, pricing, customer ownership, and cross-record invariants.
    - Database: enums/checks/FKs, positive quantities and amounts, valid date ordering, currency, uniqueness, and snapshot immutability.
    - Provider boundary: validate webhooks and external API responses.
   Currently every handler reads raw req.body or casts query strings, for example [ordersView.ts (line 12)](/Users/wpalmeri/Documents/Github/codebase-walkthrough-interview/src/views/ordersView.ts:12). Invalid requests usually become leaked internal 500 errors: [server.ts (line 10)](/Users/wpalmeri/Documents/Github/codebase-walkthrough-interview/src/server.ts:10).
12. Add audit and reconciliation infrastructure.
    Record actor, request ID, reason, previous version, new version, and timestamp for financial transitions. Run continuous invariants:
    - Posted total equals sum of posted lines.
    - Amount paid equals valid payment applications.
    - No payment or invoice is overapplied.
    - Posted snapshots have not changed.
    - Closed-period report checksums are stable.
    - Every requested delivery is delivered, actively retrying, or alerted.
   This is what lets the CEO say, “We detected and corrected it before the customer called.”
13. Establish a real Postgres migration history.
    There is no migrations directory; setup uses prisma db push: [package.json (line 10)](/Users/wpalmeri/Documents/Github/codebase-walkthrough-interview/package.json:10). Production should use reviewed SQL migrations and prisma migrate deploy.
    For decimal and snapshot changes:
14. Add nullable new columns/tables without defaults.
15. Dual-write old and new formats.
16. Backfill in small, resumable primary-key batches.
17. Compare old/new calculations and stop on mismatches.
18. Add indexes concurrently.
19. Add constraints NOT VALID, then validate separately.
20. Switch reads after shadow verification.
21. Enforce NOT NULL and immutability.
22. Remove legacy columns in a later release.
   PostgreSQL documents that normal index creation blocks writers while CREATE INDEX CONCURRENTLY does not, although it performs more work; it also supports NOT VALID followed by lower-lock validation. PostgreSQL index documentation, PostgreSQL constraint documentation.
14. Use Postgres in integration tests.
    SQLite does not exercise Postgres precision, row locking, isolation, enum, constraint, or migration behavior. Keep SQLite only for optional local demos; CI and financial integration tests should run against ephemeral Postgres.
15. Add missing indexes and move reporting into SQL.
    There are no explicit non-unique indexes. At the stated volume, loading every invoice and order item into Node will become expensive. Index invoice accounting date/status/customer, order customer/date/status, transmission status/next-attempt, and all hot foreign keys. Aggregate posted invoice totals in SQL or a reconciled ledger table. Add cursor pagination to every collection endpoint.
16. Add authentication, authorization, and tenant boundaries.
    The application itself contains no authentication or authorization. If a gateway supplies authentication, the service must still enforce roles and customer/tenant scope. If Customer represents a tenant rather than a bill-to account, the entire schema currently lacks tenant isolation; that is a release blocker.
17. Patch audited dependencies and automate updates.
    Today’s audit reported six advisories in the server dependency tree and two in the client tree, including current qs, Prisma tooling, Vite, and esbuild findings. Upgrade with regression tests, ensure development servers are never publicly exposed, and add automated dependency PRs.
## P2 — maintainability and engineering standards
18. Introduce Oxlint, but configure it deliberately.
    A baseline run completed with nonzero findings: repeated mutating-sort findings, deep/large controller functions, loose equality, and many pedantic warnings. Several .sort() usages already clone their arrays, and the suggested toSorted() requires a newer library target than the current ES2022 configuration, so blindly accepting every recommendation would be counterproductive.
    Start with correctness/suspicious rules as errors; ratchet selected warnings later. Add React, TypeScript, import, accessibility, and test rules. Oxlint supports custom JavaScript plugins, but that interface is still alpha, so critical financial enforcement should also have schema/architecture tests. Oxlint custom-plugin documentation.
    Suggested custom controls:
    - No unvalidated req.body, req.query, or req.params.
    - No raw financial status literals outside state-machine modules.
    - No direct Prisma mutations outside approved repositories/domain services.
    - No number-typed fields with financial names.
    - No Float monetary Prisma fields.
    - No posted-record update/delete operations outside controlled transitions.
Type-aware Oxlint currently requires `oxlint-tsgolint` and TypeScript 7; this repository resolves TypeScript 5.9, so retain `tsc --noEmit` while planning that upgrade. [Oxlint type-aware documentation](https://oxc.rs/docs/guide/usage/linter/type-aware).
19. Refactor oversized controllers and duplicated contracts.
    Extract pricing, posting, payment, reporting, and transmission domain services. Generate client types from the API contract rather than maintaining duplicate server and client interfaces. Export an Express app factory instead of listening during import so API tests can run without a real port.
20. Replace the mock PDF implementation.
    It is text prefixed with %PDF-1.4, not a valid production PDF document. Use a streaming PDF library, immutable stored artifacts, content hashes, deterministic formatting, and golden-file rendering tests.
API contract report
The current contract has understandable resource names, but it is not production-grade REST:
- PUT is being used for partial updates; add PATCH and retain the existing routes as compatibility adapters.
- Every success defaults to 200; creates should return 201 with Location, while queued delivery should normally return 202.
- Every failure becomes 500, including invalid methods and missing records.
- No pagination, filtering contract, request idempotency, optimistic concurrency, or conditional updates exist.
- Financial commands are retry-unsafe.
- Dates are ambiguous. to=YYYY-MM-DD becomes midnight and excludes most of that day, while local timezone bucketing can move invoices between quarters.
- Monetary JSON numbers cannot preserve the intended decimal contract.
- There is no OpenAPI definition, runtime output validation, or compatibility testing.
Additively, I recommend:
- Keep /api/* operational as a legacy adapter.
- Introduce a documented /api/v1/* contract generated from the same runtime schemas.
- Add PATCH /orders/:id and PATCH /invoices/:id with a version/ETag precondition.
- Model POST /invoices/:id/transmissions and POST /payments/:id/applications as resource creation.
- Preserve /post, /send, and /apply as deprecated aliases until usage reaches zero.
- Return consistent 400/404/409/412/422 responses using standard machine-readable Problem Details rather than exposing exception messages. RFC 9457.
- Add cursor pagination, explicit sort/filter fields, idempotency keys, request IDs, and deprecation headers.
- Add consumer contract tests preventing accidental breaking changes.
Test strategy
The repository currently contains no tests or CI configuration.
Unit tests
Build a broad Vitest suite for:
- Tier boundaries, incomplete tiers, floors, ceilings, fractional quantities, and extreme values.
- Decimal rounding and line-to-invoice reconciliation.
- Discount eligibility, ordering, exclusivity, and stacking policy.
- State-machine transitions.
- Validation schemas.
- Report period/timezone boundaries.
- Payment allocation and reversal rules.
- Idempotency behavior.
- PDF/output formatting.
Add property-based pricing tests: no negative charges, deterministic results, totals equal line sums, and monotonic behavior where appropriate.
Postgres integration and API tests
Use Testcontainers or a CI Postgres service. For each suite:
1. Create an isolated database.
2. Apply production migrations.
3. Load deterministic fixtures.
4. Start the app factory in-process.
5. Exercise the API using Supertest.
6. Destroy the database.
Critical interleaving/failure tests:

- Order edit racing invoice post.
- Rate update racing order creation.
- Two concurrent invoice-number allocations.
- Duplicate post/send requests with the same idempotency key.
- Two payment applications racing for the same remaining balance.
- Wrong-order item IDs submitted in an order update.
- Provider accepts delivery, then the request times out.
- Process crash before and after outbox commit.
- PDF generation failure.
- Bounce or portal failure arriving after acceptance.
- Report reads while product/rate/customer data changes.
- Posted invoice remains identical after all upstream records change.
- Closed-period revenue checksum remains stable.
- Migrations run while representative reads and writes continue.
Recommended implementation sequence
1. Hotfix reports, posted-order guards, invoice date/repost guards, and delivery ordering.
2. Introduce the central decimal pricing engine and comprehensive unit tests.
3. Add transaction-safe posting/payment workflows and idempotency.
4. Add snapshot tables/columns through expand-and-backfill migrations.
5. Switch reports and invoices to snapshots; add period close and immutability.
6. Implement outbox delivery, retries, provider callbacks, and monitoring.
7. Add API schemas/OpenAPI, compatibility routes, and Postgres E2E tests.
8. Add Oxlint/custom controls, CI, dependency updates, indexes, and final cleanup.
A sensible subagent split for implementation is: financial model/migrations, API validation/contracts, test/CI/lint infrastructure, with the primary agent integrating reporting, posting, and delivery semantics.