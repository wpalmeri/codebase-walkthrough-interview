# What comes next

These items are intentionally deferred while core financial correctness, transaction safety, snapshots, and tests are completed.

## Continuous financial reconciliation

The read-only `bun run db:audit:financial` scanner is implemented and detects inconsistent existing state across exact values, currencies, captured pricing and invoice identity, line and invoice totals, payment applications and reversals, and lifecycle/accounting dates. It reports stable issue codes and nonzero exit statuses without modifying financial history.

- Run a complete scan against a consistent restored production snapshot before rollout, investigate every violation or incomplete page, and retain the machine-readable zero-issue result as deployment evidence before making exact financial fields required.
- Run the scanner in production with read-only database credentials, bounded batches, and an explicit low-write or consistent-snapshot strategy so concurrent writes cannot create misleading cross-page results.
- Schedule recurring scans, export reconciliation freshness and violation counts as bounded metrics, and alert operators on new drift. Never automatically rewrite inconsistent financial history; route each issue through an auditable correction or compensating-entry workflow.
- Add a reviewed issue-suppression or disposition record for irreducible legacy evidence so accepted exceptions remain explicit, attributable, time-bounded, and distinct from a clean result.

## Production observability

The service has a useful minimum operational foundation—validated request IDs, redacted structured 5xx events, public liveness/readiness checks, graceful shutdown, append-only business audit events, and constrained delivery telemetry—but it does not yet have production-grade observability.

- Add vendor-neutral OpenTelemetry traces and metrics with W3C trace-context propagation. Instrument normalized HTTP routes, Prisma/database latency and pool pressure, external delivery calls, reconciliation, backfills, and scheduled jobs without recording request bodies, credentials, customer data, invoice identifiers, or recipient addresses.
- Emit RED metrics by bounded labels: request rate, errors, and duration by route template/method/status; add idempotency contention/replay/failure, database saturation, accounting-close, invoice-delivery, reconciliation-drift, and backfill progress counters and histograms. Reject unbounded identifiers as metric attributes.
- Replace remaining ad hoc process logs with one structured logger carrying service, environment, release, severity, request ID, and trace/span IDs. Centralize collection and retention, preserve the existing redaction contract, and ensure a broken telemetry exporter never blocks a response or financial transaction.
- Define service-level indicators and objectives for API availability, p95/p99 latency, 5xx rate, readiness, database health, invoice-delivery latency/failure, and reconciliation freshness. Add dashboards, burn-rate alerts, synthetic probes, and linked operator runbooks with actionable thresholds and ownership.
- Add error tracking for unexpected exceptions and failed background work, grouped by stable error code and release rather than raw payload. Test sampling, exporter failure, PII/secret exclusion, trace propagation, and metric-cardinality limits in CI.

## Durable invoice delivery

- Add a transactional outbox record when a delivery is requested, with a unique idempotency key, immutable recipient/payload snapshot, artifact hash, and provider-specific destination.
- Process the outbox with bounded retries, exponential backoff plus jitter, per-provider rate limits, leases, and a dead-letter state that requires an operator decision.
- Persist provider message/job IDs and attempted, accepted, delivered, bounced, complained, failed, and next-attempt timestamps. Never treat provider acceptance as final delivery.
- Store the exact immutable PDF artifact in durable object storage and send by content hash so retries cannot produce a different invoice.
- Add dashboards and alerts for stuck, retrying, bounced, or undelivered invoices well before their due date; expose a safe manual replay action with audit history.

## Provider callbacks

- Authenticate and validate email, portal, and clearinghouse webhooks; retain the raw event safely, deduplicate provider event IDs, and process state changes idempotently.
- Reconcile out-of-order callbacks and polling results against a monotonic delivery state machine.
- Track recipient health from hard bounces and complaints, block known-bad addresses, and require an explicit corrected address before retrying.

## Customer webhooks

- Let customers register versioned HTTPS webhook endpoints for events such as `invoice.ready`, `invoice.posted`, `invoice.delivery_changed`, `invoice.due_soon`, and `payment.applied`.
- Provide scoped signing secrets with rotation, HMAC signatures, timestamps/replay protection, endpoint verification, per-endpoint event filters, and customer-safe payload boundaries.
- Deliver customer events through the same durable outbox pattern with idempotent event IDs, retry/backoff, delivery logs, replay tooling, and automatic disabling of persistently failing endpoints.
- Publish versioned event schemas and compatibility guarantees; never include secrets or unrelated customer data in webhook payloads.

## Reminders and dunning

- Add operator-configurable reminder policies for pre-due, due, and overdue invoices, respecting business calendars, customer time zones, disputes, partial payments, and communication preferences.
- Re-evaluate eligibility transactionally before every reminder so paid, voided, disputed, or already-notified invoices are not contacted.
- Record reminder attempts as auditable delivery resources and feed bounce/failure outcomes back into recipient health and operations alerts.
