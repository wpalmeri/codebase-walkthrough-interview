# Midmarket EHR Platform — Engineering Lead Exercise

Welcome, and thanks for taking the time. This repository is a working EHR and
revenue-cycle platform for a mid-market healthcare company. It runs locally with
one command and is backed by a realistic (synthetic) dataset.

## What this exercise is

**You are reviewing this codebase and writing a development plan — you are not
fixing anything.** No code changes are expected or graded. Spend your time
reading the code, tracing behavior, and forming a point of view.

- **Time:** target two hours or less. It is deliberately larger than you can read
  end to end; part of the exercise is deciding where to look.
- **AI is encouraged.** This was designed expecting you to use AI tools to
  navigate the repo, trace call paths, compare options, and organize findings.
  There is nothing to disclose and no penalty for using them.
- **No length limit** on your write-up. Be as detailed as the point requires.

**[`EXTERNAL_INTERVIEW.md`](./EXTERNAL_INTERVIEW.md) is the brief.** It has the
company context, the business commitments driving the roadmap, and the exact
deliverable. Read it first; this README just gets you running and oriented.

## Setup

Requirements: **Node.js 22** (20.11+ works), **npm 10+**, and **Docker** (for the
local PostgreSQL). One command does everything:

```bash
./scripts/bootstrap.sh
```

It checks tools, starts PostgreSQL, installs pinned dependencies, waits for the
database, syncs and seeds the schema, and runs typecheck + tests. Then:

```bash
npm start
```

- Application UI: <http://localhost:3000>
- OpenAPI docs: <http://localhost:3000/docs>
- Health check: <http://localhost:3000/health>

If Docker is unavailable, any PostgreSQL 16 works: create an empty database, set
`DATABASE_URL` in `.env`, then `npm install && npm run setup && npm start`. If host
port 54329 is taken, change it in `docker-compose.yml` and `.env`. No cloud
credentials or paid APIs are needed — the clearinghouse, CRM, webhooks, and the AI
model provider are all simulated locally.

## How to explore

The fastest way in is to **click around the UI at <http://localhost:3000>** (it
runs on the same seeded data) and read the code behind whatever looks
interesting. Stable seed identifiers you can use directly in code, the API, or
`/docs`:

| Thing | ID |
|---|---|
| Primary organization | `org_northstar` |
| Enterprise organization | `org_evergreen` |
| Admin user | `user_admin` |
| Branch-limited viewer | `user_viewer` |
| Patient | `patient_000` |
| Order | `order_0` |
| Visit set → group → visit | `visit_set_0` → `visit_group_0_0` → `visit_0_0_0` |
| Accounting period | `period_may` |

The [`docs/`](./docs) folder is written in the voice of the fictional company and
is worth skimming — especially [`docs/support-tickets/`](./docs/support-tickets)
(real-sounding incident reports), [`docs/finance/`](./docs/finance),
[`docs/performance/`](./docs/performance), and
[`docs/product-notes/`](./docs/product-notes).

## Where the code lives

The subject of your review is the **backend application code under `src/`**. The
modules below are where the architecture, data-model, and correctness decisions
live — this is what to read:

| Area | Path |
|---|---|
| Intake, patients, orders | `src/intake`, `src/orders` |
| Scheduling, visits, the legacy visit hierarchy | `src/visits`, `src/legacy` |
| Clinical documentation | `src/documentation` |
| Pricing / rate resolution | `src/pricing` |
| Revenue cycle (charges, claims, statements) | `src/revenue-cycle` |
| Accounting (month close, cash application) | `src/accounting` |
| Reporting | `src/reporting` |
| Permissions / authorization | `src/permissions` |
| Events, workflows, integrations | `src/events`, `src/workflows`, `src/integrations` |
| AI employee prototype | `src/ai-employee` |
| Domain models, shared libs | `src/domain`, `src/lib` |
| Data model + seed | `prisma/schema.prisma`, `prisma/seed.ts` |

**Supporting scaffolding — present so the system runs and is explorable, but not
the focus of the exercise:** the browser app (`public/`, `src/ui/`), the HTTP
route wiring (`src/http`), local simulators (clearinghouse/CRM/webhooks), the
seed script, and the tests. You are welcome to read them for context, but you are
not being asked to evaluate the UI or the test harness.

Not everything here is a problem: a meaningful portion of the code is sound and
worth building on. Part of the judgment being assessed is telling the difference,
and prioritizing rather than treating every code smell equally.

## Command reference

```bash
npm run setup             # generate client, sync schema, seed data
npm run bootstrap         # full first-time setup incl. PostgreSQL and tests
npm run dev               # start API with file watching
npm run worker            # process pending domain events on an interval
npm run check             # typecheck + test suite
npm run test:integration  # database-backed tests only
npm run benchmark         # representative request timings
npm run db:reset          # reset and reseed the local database
```

`npm test` expects the seeded local database — run `npm run setup` first.

## Data safety

Every person, organization, identifier, note, claim, and payment is synthetic.
Normal test runs make no external network calls; workflow webhook examples target
a local simulator.
