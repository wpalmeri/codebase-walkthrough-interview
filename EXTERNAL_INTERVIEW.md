# Engineering Lead Take-Home: EHR Platform Development Plan

## Overview

You are joining a healthcare software startup as its engineering lead. The company operates an EHR, clinical operations, revenue-cycle, and accounting platform for mid-market healthcare providers.

Your task is to review an existing repository and recommend how the engineering team should evolve it while delivering several urgent product commitments. We are interested in how you connect technical decisions to business outcomes, choose scope, manage risk, and create an incremental plan for a system that must remain operational.

This is a planning exercise. You are not expected to implement changes or identify every issue in the repository.

## Company and system context

The company currently supports:

- 20 customer organizations
- Approximately 300 active patients per customer each month
- Approximately 6,000 monthly active patients in total
- 50,000–75,000 visits per month
- Approximately 1–2 million historical visits
- Clinical, operational, billing, payment, and reporting workflows
- Protected health information and sensitive financial data

The application is a TypeScript modular monolith backed by PostgreSQL. Background workers handle some asynchronous processing and integrations. The company deploys frequently and does not have regular maintenance windows.

The engineering organization has eight engineers. For planning purposes, assume that four engineers, including the engineering lead, can contribute materially to the initiatives below. Other engineers must continue supporting customers and maintaining the rest of the product.

## Product modules

The repository covers five primary areas.

### Intake

- Create or match patients
- Capture demographics and insurance coverage
- Verify eligibility
- Create service orders and authorizations
- Estimate patient responsibility

### Patient documentation

- Schedule and complete visits
- Record service delivery
- Write, sign, and amend clinical notes
- Track documentation completeness

### Revenue cycle

- Determine billable services and prices
- Generate charges and claims
- Submit claims through a clearinghouse integration
- Handle rejections, corrections, and resubmissions
- Generate patient statements

### Accounting: month close

- Calculate revenue and accounts receivable
- Reconcile operational and financial records
- Close an accounting period
- Handle corrections discovered after close

### Accounting: cash application

- Import remittances and payments
- Match payments to claims and charge lines
- Handle partial payments, denials, reversals, and unapplied cash
- Produce reconciliation reports

## Current business commitments

### 1. Launch an AI employee capability

A competitor has launched an “AI employee,” and the company is beginning to lose deals because it lacks a credible response. Sales wants an initial product in customers’ hands within six weeks.

The initial request from leadership is broad:

> Give every customer an AI employee that can monitor their operations and perform work on their behalf.

Customer conversations have surfaced several possible jobs:

- Find visits that cannot be billed and explain why
- Identify missing documentation and notify the appropriate employee
- Draft corrections for rejected claims
- Answer questions such as “Why did revenue decrease this week?”
- Resubmit claims or assign follow-up tasks after approval
- Execute customer-defined operational workflows

You should recommend an appropriate initial scope rather than assuming all of these capabilities must ship together. Consider product value, safety, permissions, auditability, reliability, latency, cost, and how success would be evaluated.

### 2. Implement a large enterprise contract

The company has signed a strategically important enterprise contract. The first locations are expected to begin onboarding in twelve weeks, followed by a phased rollout.

The customer requires:

- Hierarchical organizations, regions, branches, and teams
- More advanced permissions than the current role system supports
- Users with access to different subsets of patients and locations
- Separation of clinical, operational, and financial access
- Temporary and delegated access
- Detailed audit exports
- Deeper operational and financial reporting
- Custom fields and customer-specific product edge cases
- A phased rollout across locations

Some requests may be broadly valuable platform capabilities, while others may be configuration, implementation work, or inappropriate one-off behavior. Your plan should make those distinctions.

### 3. Make month-end close reproducible

Finance has found that the numbers for a closed month can change after the month is closed. Examples include changes after insurance corrections, payer-rate updates, visit amendments, payment reversals, or rerunning a report.

The core business requirement is:

> Once a month is closed, its reported financial position must remain reproducible. Later corrections must appear as explicit adjustments rather than silently changing historical results.

The company does not need a complete enterprise general-ledger product as a prerequisite for solving this problem.

### 4. Improve reporting and support custom reports

Existing reports are slow, occasionally time out, and sometimes disagree about common metrics. The enterprise customer wants the ability to create reports using patient, order, visit, documentation, clinician, authorization, claim, payment, location, and custom-field data.

They have requested filters, groupings, calculated values, scheduled exports, and permission-aware results. It is not yet decided whether this should be a configurable set of report templates, a governed report builder, a BI integration, or a broader analytical platform.

### 5. Support customer-defined workflows

The enterprise customer wants to configure side effects in response to activity in the product. Examples include:

- Notify a supervisor when a completed visit remains unsigned for four hours
- Create a task when a claim is rejected
- Update an external CRM when a patient changes branches
- Require review when a high-value payment is received
- Alert operations when an order approaches its authorization limit

The original customer request is to support custom side effects after “any action in the system.” Your plan should define a safe and useful product boundary, including what must be delivered for the initial enterprise rollout.

### 6. Improve application performance

The application is slow during common workflows, particularly for larger customers. Current symptoms include:

- Patient and order pages taking 3–6 seconds
- Some requests executing hundreds of database queries
- Slow authorization and visit-count calculations
- Reports running for minutes or timing out
- Visit completion waiting on unrelated side effects
- Slow permission checks on lists
- Large pages calculating exact result totals before returning data

The initial performance objectives are:

- Core interactive pages below one second at p95
- Visit completion below two seconds at p95
- Common operational reports below five seconds
- Large reports processed asynchronously with visible status
- No compromise to correctness, access controls, or auditability

## Constraints

- The AI release is expected in six weeks.
- Enterprise onboarding begins in twelve weeks.
- The application must remain operational during migration.
- Existing APIs and integrations cannot all migrate at once.
- Database migrations should be backward-compatible and avoid long blocking operations.
- Historical claims and closed financial results must be explainable.
- Some views can be eventually consistent; authorization, access-control, and financial decisions may require stronger guarantees.
- Leadership will not support a broad microservices rewrite or a multi-quarter feature freeze without unusually strong justification.
- You have incomplete information. Clearly state important assumptions and questions.

## Assignment

Review the repository and supporting materials, then prepare a development proposal that addresses the business commitments above.

Your deliverable must contain the following four sections.

### 1. Technical issue map

Map the important technical issues you find across the repository. For each important issue, concisely identify:

- The relevant module, data model, or architectural boundary
- Evidence from the repository
- The product or business consequence
- The likely scope or depth of a solution
- Important dependencies on other issues

The map should show meaningful relationships among issues rather than functioning only as a list of code smells. It does not need to be exhaustive.

### 2. Prioritization and sequencing

Prioritize the issues and propose the order in which they should be addressed. Explain:

- Which issues require immediate containment
- Which issues block the AI or enterprise commitments
- Which improvements can deliver near-term value without a broad refactor
- Which deeper changes should be deferred
- Where short-term work should create a migration seam for later work
- What you would intentionally leave unchanged

Include dependencies, critical-path decisions, and the reasoning behind material tradeoffs.

### 3. Proposed end state

Describe where the repository and system architecture should ultimately go. Focus on the boundaries, data ownership, and invariants that matter most rather than designing every module.

Your end state should address the most important interactions among:

- The core visit and order model
- Pricing and reproducible financial records
- Enterprise permissions
- Operational and custom reporting
- Business events and customer workflows
- The AI employee and its permitted actions
- Application performance

Explain which parts of the current system should remain, which should be adapted, and which should eventually be retired.

### 4. Short-, medium-, and long-term plan

Provide a phased development plan:

- **Short term: 0–6 weeks.** Include what you would do in the first two weeks and what must ship for the initial AI commitment.
- **Medium term: 6–12 weeks.** Cover the first enterprise rollout, required platform capabilities, and continuation of the highest-value migrations.
- **Long term: following 3–6 months.** Describe the target-state migrations and technical-debt reduction justified by the product direction.

For each horizon, identify expected business outcomes, major technical deliverables, team allocation, rollout or migration approach, and measures of success. Include relevant backfill, compatibility, observability, reconciliation, and rollback considerations.

The proposal should also state its most important assumptions, unanswered questions, and decisions requiring product, finance, operations, or customer input.

You do not need to propose a solution for every issue you encounter. Clear prioritization and explicit deferral are core parts of the exercise.

## Evidence and calibration

For your most important conclusions, distinguish among:

- **Observed:** Directly supported by code, tests, data, or supplied artifacts
- **Inferred:** Likely based on the available evidence but not proven
- **Assumed:** An assumption made to construct the plan
- **Needs validation:** A question requiring input from product, finance, operations, customers, or further technical investigation

Include file references for the most important technical observations. We are interested in the strength of the evidence, not the number of citations.

## Format and timebox

- Spend no more than two hours on the exercise. Please stop after two hours even if there are additional areas you would like to investigate.
- Diagrams, small schema examples, pseudocode, or rough project breakdowns are welcome but optional.
- No production implementation is required.

## Use of AI and other tools

Use of AI assistants is heavily encouraged. The exercise is intentionally designed with the expectation that candidates will use AI to navigate the repository, trace behavior, compare alternatives, and organize findings. You may also use any normal engineering reference or analysis tools.

You do not need to describe or disclose how you used AI. You remain responsible for the conclusions in your submission and should be prepared to explain the evidence, tradeoffs, and decisions in a follow-up conversation.

## Follow-up discussion

The take-home will be followed by a 45-minute working session. We will discuss your priorities, inspect selected repository evidence, and introduce one or two changing business constraints. The objective is collaborative problem solving, not defending a fixed answer.

## What we are evaluating

We are primarily interested in:

- Connecting architecture to customer and business outcomes
- Technical judgment in backend, data-model, and platform decisions
- Appropriate project scope and sequencing
- Balancing near-term delivery with a better future state
- Incremental migration and operational safety
- Performance diagnosis grounded in evidence
- Clear communication, calibration, and willingness to remain in the details

There is no single expected architecture or roadmap.
