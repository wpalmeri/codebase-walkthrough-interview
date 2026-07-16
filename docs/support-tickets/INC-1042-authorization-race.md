# INC-1042: Authorization limit exceeded

| Field | Value |
|---|---|
| Reported by | Dana Whitfield, Scheduling Operations (Northstar Home Health) |
| Date reported | 2026-01-14 |
| Severity | SEV-2 (High) — payer compliance |
| Environment | Production; web scheduling screen; Northstar Home Health |
| Component | Scheduling / authorization enforcement |
| Status | Open |

## Summary

Two schedulers booked visits for the same patient at nearly the same time. Both
screens showed one authorized visit remaining. Both bookings were accepted,
leaving the order one visit beyond its payer authorization.

## Steps to reproduce (as reported)

1. Open the scheduling screen for a visit set that has one authorized visit
   remaining (`maxVisits` minus used equals one).
2. From a second session, open the same visit set's scheduling screen. Both show
   "1 of N authorized visits remaining."
3. Have both schedulers confirm a new visit within a few hundred milliseconds of
   each other.
4. Both bookings succeed.

## Observed

The visit set now has one more scheduled visit than the authorization allows.
Nothing warned either scheduler at confirmation time.

## Expected

Once the authorized limit is reached, the next booking should be rejected, even
if two bookings arrive at almost the same moment.

## Frequency and impact

Has occurred twice in the last six months. Each time, operations cancelled one
visit and contacted the patient to reschedule, and billing flagged the extra
visit as at risk of non-payment. Low frequency but high sensitivity because it
touches payer compliance.

## Preliminary engineering note (tentative)

Not yet reproduced under controlled load. The pre-schedule check
(`assertVisitAllowed` in `src/orders/authorization-service.ts`) appears to count
used visits and compare against the maximum, and the visit is then created by the
caller in a separate step. Two requests that both pass the check before either
creates its visit would both be allowed. This is a hypothesis; we should confirm
with a concurrent test before proposing a fix, and decide what "used" should mean
at enforcement time (scheduled vs completed).
