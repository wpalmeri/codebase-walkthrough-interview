# INC-1132: Large order page takes six seconds

| Field | Value |
|---|---|
| Reported by | Support, on behalf of enterprise onboarding |
| Date reported | 2026-06-30 |
| Severity | SEV-3 (Medium) — performance, urgent ahead of rollout |
| Environment | Production; order detail page |
| Component | Orders / order detail |
| Status | Open |

## Summary

An order containing historical treatment groups takes between five and seven
seconds to load. Traces show repeated patient, documentation, authorization,
charge, and group queries. Newer orders load faster but still issue more than 100
database queries in production.

## Steps to reproduce (as reported)

1. Open the detail page for an order with a long history of treatment groups and
   visits.
2. Observe load time and, in the trace, the number and repetition of queries.
3. Repeat for a small, recently created order for comparison.

## Observed

- Large historical order: 5–7 seconds to first render.
- Small recent order: faster, but still 100+ queries per load.
- Query count scales with how much history the order carries.

## Expected

The order detail page should load in roughly a second, and query count should not
grow with the size of the order's history.

## Impact

Enterprise onboarding is imminent and these customers have larger, older orders.
Support has asked for an immediate improvement before rollout so the order page is
not a first-impression problem.

## Preliminary engineering note (tentative)

`getOrderSummary` (`src/orders/order-summary.ts`) loads the full order → visit
sets → groups → visits → notes/charges graph in one query and then issues
separate count queries on top. The per-row hydration and the breadth of the
included relations both scale with the order's history, which is consistent with
the trace. We should profile to confirm the dominant cost (graph size vs the
extra counts vs serialization) before choosing an approach; see
`docs/performance/baseline.md`.
