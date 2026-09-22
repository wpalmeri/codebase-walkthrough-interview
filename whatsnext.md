# What comes next

These items are intentionally deferred while core financial correctness, transaction safety, snapshots, and tests are completed.

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
- Provide scoped signing secrets with rotation, HMAC signatures, timestamps/replay protection, endpoint verification, per-endpoint event filters, and tenant isolation.
- Deliver customer events through the same durable outbox pattern with idempotent event IDs, retry/backoff, delivery logs, replay tooling, and automatic disabling of persistently failing endpoints.
- Publish versioned event schemas and compatibility guarantees; never include secrets or unrelated customer data in webhook payloads.

## Reminders and dunning

- Add tenant-configurable reminder policies for pre-due, due, and overdue invoices, respecting business calendars, customer time zones, disputes, partial payments, and communication preferences.
- Re-evaluate eligibility transactionally before every reminder so paid, voided, disputed, or already-notified invoices are not contacted.
- Record reminder attempts as auditable delivery resources and feed bounce/failure outcomes back into recipient health and operations alerts.
