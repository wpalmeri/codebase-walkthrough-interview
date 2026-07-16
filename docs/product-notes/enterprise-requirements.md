# Enterprise Customer Requirements

Requirements capture for the Evergreen Behavioral Health deal. Evergreen is the
first `enterprise` account and the largest by patient volume. This document
records what the customer has asked for, gathered from sales calls, the security
questionnaire, and two operations workshops. It is a capture of requests and open
questions, not a committed design.

## Deal shape and rollout

- Evergreen operates multiple regions, each with several branches, and staffs
  branches through teams. The contract covers the full hierarchy but acceptance
  is staged.
- The first two branches are expected to begin onboarding in about twelve weeks.
  Additional regions follow over the subsequent quarter.
- Contractual acceptance is based on the first rollout succeeding, not on every
  requested enhancement shipping. The team's job for the first milestone is to
  make the first locations correct and safe, and to have a credible path for the
  rest.
- Evergreen already exists in the seed as an `enterprise: true` organization with
  a region/branch/team structure, so the data model carries the hierarchy today
  even though most enforcement does not yet use it.

## Organization and access model

Evergreen's access requirements are more granular than the four current roles
(`ADMIN`, `CLINICIAN`, `BILLER`, `VIEWER`). Requests heard so far:

| Persona | Access requested |
|---|---|
| Corporate finance | Financial data across every region; no clinical documentation |
| Regional clinical leader | Documentation across their region; no patient balances |
| Branch scheduler | Patient schedules only for assigned branches |
| Centralized intake | Limited patient access before a patient is assigned to a branch |
| Contract clinician | Only assigned patients; access ends automatically when the engagement ends |
| Supervisor on leave | Temporary delegated access granted to a covering supervisor |
| Compliance | Read of who accessed or changed a record, exportable per branch or patient |

This implies several access dimensions the platform does not fully enforce today:
region scoping, team scoping, a clinical-versus-financial split that is finer
than role, assigned-patient access, time-boxed access, and delegation. The
`DelegatedAccess` and `UserBranch` (with `expiresAt`) tables exist in the schema;
delegation is not currently read by any code path, and branch access is applied
in different places by different endpoints (query-level scoping on newer
endpoints, per-row filtering on older ones).

Open questions:

- What is the unit of scoping the customer actually manages — branch, region,
  team, or explicit patient assignment — and how do those combine when a user has
  more than one?
- Should scoping be enforced in the query or after rows are loaded? The two
  approaches currently disagree on some export paths.
- Who may grant delegated or temporary access, and what is the maximum duration?
- When a contract clinician's engagement ends, what happens to records they
  authored or are mid-workflow on?

## Audit and export

- Evergreen's compliance team wants audit exports that explain who accessed or
  changed sensitive records, filterable by branch, patient, and time window.
- Exports must carry the same access rules as the interactive screens, so that an
  export never contains rows a user could not see in the UI.
- The current branch access audit attributes activity to a branch by the actor's
  permissions rather than by the resource touched, and resolves some branch
  membership through the visit hierarchy; the customer's expectation is
  resource-level attribution.

Open questions:

- What is the authoritative branch of a visit that has been relocated, for both
  reporting and access purposes?
- What retention and immutability guarantees does compliance need on the audit
  log itself?

## Reporting

- Configurable columns, filters, groupings, and calculated measures.
- Custom patient and visit fields available as report columns.
- Saved report definitions shared by role, branch, or region.
- Scheduled delivery to approved destinations.
- Operational reports that reflect recent activity.
- Financial reports that reconcile to closed periods — a report run for a closed
  month should match what finance closed (see `docs/finance/month-close.md`).

The customer has asked whether its analysts can write SQL directly against their
data. Security posture, tenancy isolation, and deployment for that have not been
agreed.

Open questions:

- Which reports must reconcile to a closed period, and which are allowed to move
  with live data?
- How are custom-field columns resolved at report scale without a per-row lookup?
- What destinations count as "approved" for scheduled exports, and how are their
  secrets managed?

## Custom fields

- Evergreen wants custom patient and visit fields, some required at intake, and
  wants them in every visit export. Three extra export columns
  (`referral_source`, `region_name`, `auth_number`) are already promised and are
  assembled per row today.
- Some fields are expected to change type or option list over the life of the
  account.

Open question: what is the expected behavior of values already stored when a
field's type or options change?

## Customer-specific behavior

Several Evergreen-specific rules have already been agreed and currently live in
shared code (`src/config/customer-overrides.ts`). They are noted here because they
affect how the enterprise account differs from the standard product:

- Claims may go out with unsigned notes ("until Q3"), an exception to the standard
  documentation gate.
- Claim aging is bucketed weekly rather than 30/60/90.
- Cancelled visits count against authorization limits, because Evergreen's payer
  counts them; every other customer excludes them.
- The three extra export columns above.

Open question: which of these are permanent contractual terms versus temporary
accommodations, and how should per-customer behavior be expressed so it does not
have to live inline in shared services?

## Workflows

Evergreen expects to automate operational responses. Examples requested:

- Escalate unsigned documentation after four hours.
- Create an integration task after a claim rejection.
- Notify finance about payments above a configurable threshold.
- Synchronize branch assignment to the customer CRM, with both current and legacy
  identifiers.
- Alert a scheduler before an authorization is exhausted.

The sales requirements include the phrase "after any action in the system," which
has not been translated into a supported event catalog. Today workflows trigger
on specific `DomainEvent` names matched exactly, and the event names use three
naming conventions, so "any action" is not currently a well-defined trigger set.

Open questions:

- What is the committed catalog of events a customer workflow may subscribe to?
- What actions may a workflow take, and which require human review before they
  take effect?
- How are workflow secrets stored and rotated, and what are the delivery, retry,
  and replay guarantees the customer can rely on?
