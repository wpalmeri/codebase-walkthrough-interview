# Clearinghouse Submission Contract

This document describes the contract between the platform and the claims
clearinghouse: how a claim is submitted, how it is acknowledged, how rejections
arrive, and how the local simulator stands in for the vendor. It reflects current
behavior.

## Submission

`POST /simulators/clearinghouse`

The clearinghouse accepts a claim submission and assigns an external identifier.
The documented envelope carries claim and payer identifiers, the legacy visit-set
and group identifiers the vendor still keys on, the patient's payer member id, and
the line items:

```json
{
  "claimId": "claim-id",
  "visitSetId": "legacy-set-id",
  "visitGroupIds": ["legacy-group-id"],
  "patient": { "memberId": "payer-member-id" },
  "lines": [{ "serviceCode": "SKILLED_NURSING", "units": 1, "amount": "135.00" }]
}
```

The current client (`src/revenue-cycle/clearinghouse-client.ts`) populates a lean
subset of this envelope: `claimId`, `payerCode`, `totalAmount`, and `lines` with
`procedureCode`, `units`, and `amount`. It also attaches a generated `requestId`
of the form `REQ-{claimId}-{timestamp}` and posts to the URL in
`env().clearinghouseUrl` with a default 10-second timeout enforced by an
`AbortController`.

## Acknowledgement and external id

A successful submission returns an acknowledgement with the vendor-assigned
external id:

```json
{ "accepted": true, "externalId": "CH-claim-id-12345" }
```

On acceptance the platform writes a `ClaimSubmissionAttempt` (status `ACCEPTED`,
storing the `requestId` and `externalId`), sets the claim to `SUBMITTED`, records
the external id on the claim, and emits a `claim_submitted` domain event. The
external id is assigned by the vendor per POST; the simulator derives it from the
claim id and request id (`CH-{claimId}-{hash}`).

## Request identifier and idempotency

The clearinghouse supports an optional stable `requestId`. Reusing the same
`requestId` on a retry is intended to return the original receipt rather than
create a second claim. There is no separate idempotency key.

Today, callers do not always populate a stable request id, and the id the current
client generates includes a timestamp, so a retry produces a new `requestId`
rather than reusing the original. The claim record stores only the most recent
external id.

## Timeout behavior

Timeouts are ambiguous by design of the vendor protocol: the clearinghouse may
have accepted a submission and assigned an external id even if no response reached
the platform. In that case the local claim is left in its pre-submission state
(`READY`) with no attempt row and no external id recorded, because the attempt and
claim update are only written after the vendor call returns. A subsequent retry is
treated by the vendor as a new submission. This sequence is the subject of
INC-1088.

The simulator models this with a `simulateTimeout` flag: when set, it returns an
acceptance with an external id and a note that the connection was dropped after
acceptance, standing in for a vendor that accepted but whose response the caller
never saw.

## Rejection callback

`POST /simulators/clearinghouse/reject`

Rejections arrive asynchronously as a callback that references a submitted claim's
external id and carries a payer reason code, message, and category. The callback
ingests into `ClaimRejection` via `ingestRejection` and can move the claim to
`REJECTED`. The reason codes the simulator produces:

| Code | Category | Message |
|---|---|---|
| CO-16 | MISSING_INFO | Claim lacks information needed for adjudication |
| CO-97 | BUNDLING | Payment adjusted; service included in another service |
| PR-1 | PATIENT_RESPONSIBILITY | Deductible amount |
| CO-29 | TIMELY_FILING | Time limit for filing has expired |
| CO-11 | CODING | Diagnosis inconsistent with procedure |

The callback body accepts an optional `seed` so tests and the seed data select a
deterministic reason:

```json
{ "claimExternalId": "CH-claim-id-12345", "seed": 2 }
```

## Local simulator

The clearinghouse is simulated in-process
(`src/integrations/clearinghouse-simulator.ts`,
`src/http/routes/simulator-routes.ts`) so the exercise needs no vendor
credentials:

- `POST /simulators/clearinghouse` — accept a submission and return an external
  id (honors `simulateTimeout`).
- `POST /simulators/clearinghouse/reject` — push a rejection callback for a
  previously submitted claim.

Rejection reasons are keyed off the request id (or external id) so seed data and
tests stay stable across runs.
