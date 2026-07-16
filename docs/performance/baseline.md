# Performance Baseline

This document records the current performance of representative workflows and the
service-level objectives the team is working toward. Timings were collected from
production traces on a larger existing customer; absolute numbers vary by
environment, but query shape and relative behavior reproduce locally with the
benchmark script. Run `npm run benchmark` after setup for local request timings.

## Observed symptoms

These are the recurring observations behind the numbers below:

- Core record pages (patient overview, order detail) take roughly three to six
  seconds and issue hundreds of database queries per request.
- Several pages compute one or more exact `count` totals before fetching the page
  of rows the user actually sees.
- Authorization and visit "counts" walk the nested visit-set / group / visit
  hierarchy.
- Interactive endpoints load large ORM object graphs (full visit-set → group →
  visit → note/charge trees) even when the response uses a subset.
- List endpoints apply some permission checks per row after loading, and resolve
  some attributes (branch, custom fields) with an additional query per row.
- Visit completion runs its side effects inline, including an outbound CRM call,
  so its latency tracks a downstream dependency.
- Reports that price or enrich per visit run in minutes and can time out.
- Large responses spend meaningful time serializing the loaded graph to JSON.

## Target SLOs

These are targets, not current numbers:

| Workflow class | Target |
|---|---|
| Core interactive pages (patient, order, visit list) | < 1s p95 |
| Visit completion | < 2s p95 |
| Common reports (operational, revenue for a normal window) | < 5s |
| Large or wide reports | Run asynchronously; no interactive timeout |

Correctness, permission enforcement, and auditability must not be traded away to
hit these targets: a faster page must return the same rows the user is entitled
to see, and must not drop audit or history writes.

## Representative endpoints

Timings are p50 / p95; query counts are representative of a production-scale
customer.

| Workflow | p50 | p95 | Query count | Notes |
|---|---:|---:|---:|---|
| Patient overview | 1.8s | 3.9s | 84 | Four independent exact header counts plus coverage loading |
| Order detail | 2.7s | 6.1s | 147 | Loads the complete VisitSet/VisitGroup/Visit graph (INC-1132) |
| Visit list | 1.2s | 3.4s | 61 | Exact total, then per-row branch checks after load |
| Visit completion | 1.4s | 4.2s | 38 | Inline audit, pricing, rollup, event, analytics, and CRM call |
| Authorization usage | 0.7s | 2.8s | 9 | Counts across the nested hierarchy |
| Operations dashboard | 2.4s | 5.6s | ~40 | Each KPI card is its own query; then the group graph is hydrated |
| Claim queue (page 1) | 1.1s | 2.9s | ~30 | Exact total plus a deep per-claim include for names and attempts |
| Revenue report | 18s | timeout | 1 + N | One rate lookup per unpriced visit |
| Custom visit report | 25s | timeout | 2 + N | Custom fields and permissions resolved per row |
| Month-close calculation | 6s | 14s | ~12 | Aggregates and re-derivation over operational tables |

## Database observations

- All report and interactive requests run against the primary PostgreSQL
  instance; there is no reporting replica.
- Several list endpoints calculate exact totals before fetching rows, and most
  use offset pagination.
- Payer-rate filters do not share one consistent index or predicate across the
  paths that resolve rates.
- Historical hierarchy queries frequently load more columns and relations than the
  response uses.
- Custom fields use polymorphic entity identifiers and multiple typed value
  columns, and are read per row in reporting.
- Per-row work (branch resolution through the hierarchy, custom-field lookups,
  rate lookups) means the query count scales with result size rather than page
  size.

## Scale context

The numbers above are collected against a customer near the top of the current
range. For sizing, the platform serves on the order of 20 customer organizations,
about 300 active patients per customer per month (roughly 6,000 monthly active
patients in aggregate), and 50,000–75,000 visits per month, on top of 1–2 million
historical visits. Deploys are frequent and there is no maintenance window, so
baselines are expected to hold under continuous live traffic that mixes
interactive and reporting load on the one primary database. Per-request query
counts that scale with history or result size are the main reason large,
long-lived customers see the worst timings.

## Using the benchmark

`npm run benchmark` exercises a set of representative requests against the seeded
database and reports per-request timings and query counts. It is the intended way
to reproduce the relative behavior above locally and to check whether a change
moves a workflow's query count or latency. Because local hardware and data volume
differ from production, treat the local absolute numbers as a relative signal and
compare query counts before and after a change rather than chasing the production
timings directly.
