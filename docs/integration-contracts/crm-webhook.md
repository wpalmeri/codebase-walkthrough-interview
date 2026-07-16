# CRM and Customer Webhooks

This document describes two outbound integration paths: the push to a customer's
CRM, and the generic signed webhook delivery customers register to receive
product events. It reflects current behavior.

## CRM activity push

The platform pushes activity to the customer CRM over HTTP. There are two paths,
and they can both deliver the same activity.

**Inline push.** `notifyCrmOfVisitActivity` (`src/integrations/crm-sync.ts`) is
called inline from visit completion and from branch moves, so the originating
request's latency includes the CRM round trip. It posts to `env().crmUrl` with an
`x-tenant` header carrying the organization id and a visit-activity body:

```json
{
  "type": "visit.completed",
  "visitId": "visit-id",
  "patientId": "patient-id",
  "completedAt": "2025-06-15T12:00:00.000Z"
}
```

**Nightly sync.** `syncRecentActivityToCrm` re-sends visits completed since the
cursor stored in `IntegrationSyncState` (defaulting to the last seven days),
up to 200 at a time, and advances the cursor. Because the inline path and the
nightly path both send completed-visit activity, an activity that was delivered
inline but whose originating request later failed can be delivered a second time
by the nightly job.

For branch assignment, the enterprise CRM expects both current and legacy
identifiers:

```json
{
  "patientId": "patient-id",
  "orderId": "order-id",
  "visitSetId": "visit-set-id",
  "branchId": "branch-id",
  "changedAt": "2025-06-15T12:00:00.000Z"
}
```

CRM endpoints may return transient or permanent failures. The inline path logs a
warning and does not retry; the nightly path re-sends based on the cursor.

## Outbound webhooks

Customers register HTTP endpoints to receive product events.

### Registration

`createWebhookEndpoint` (`src/integrations/webhook-service.ts`) requires the
`workflow.manage` policy and stores a `WebhookEndpoint` with the destination URL,
a generated secret (`whsec_…`), and a JSON list of subscribed event names. The
settings screen (`listWebhookEndpoints`) returns the secret in full so the
customer can configure their receiver; secrets are stored in plaintext on the
endpoint row.

### Signing

Each delivery body is `{ "eventName": ..., "payload": ... }`. The dispatcher
(`src/integrations/webhook-dispatcher.ts`) signs the exact JSON body with
HMAC-SHA256 using the endpoint secret and sends:

- `x-signature`: hex HMAC-SHA256 of the body
- `x-event`: the event name
- `content-type: application/json`

Receivers verify by recomputing the HMAC over the raw body with their copy of the
secret.

### Event names

Event names are the domain event names from `src/events/event-names.ts`. They use
three naming styles — dot.case (`visit.completed`), PascalCase (`VisitCancelled`),
and snake_case (`claim_submitted`) — and subscriptions match the exact string, so
an endpoint subscribed to `claim.rejected` does not receive an event emitted as
`claim_rejected`. An endpoint with an empty subscription list receives all events
for its organization.

### Delivery and retry

- `dispatchEvent` creates a `WebhookDelivery` row (`PENDING`), delivers inline,
  and marks it `DELIVERED` or `FAILED` with `attempts = 1`. A failure sets
  `nextRetryAt` to one minute out.
- `retryFailedDeliveries` (run from the worker) picks up `FAILED` deliveries with
  fewer than 3 attempts whose `nextRetryAt` has passed, retries with a constant
  one-minute backoff, and increments `attempts`.
- After the fixed retry cap there is no further attempt and no dead-letter beyond
  the delivery row remaining `FAILED`.

### Workflow-triggered webhooks

Customer workflows can also call HTTP destinations directly through the `webhook`
action (`src/workflows/workflow-actions.ts`). That path posts the event payload
inline and places the configured secret in an `x-workflow-secret` header in
plaintext; it does not HMAC-sign the body the way the webhook dispatcher does.

## Open items

Secret rotation, payload versioning, replay/redelivery semantics, and the
committed event catalog for subscriptions have not been finalized. See the
enterprise requirements notes for the customer-facing side of these questions.

## Local simulators

Both destinations are simulated in-process
(`src/http/routes/simulator-routes.ts`):

- `POST /simulators/crm` — accepts an activity push and echoes it back as
  `{ "delivered": true, "received": … }`.
- `POST /simulators/webhook` — a generic receiver that records the `x-signature`
  header and returns `{ "ok": true }`.
