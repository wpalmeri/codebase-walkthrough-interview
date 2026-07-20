# Engineering Lead Take-Home: EHR Platform Priorities

## Overview

You are joining a healthcare software startup as its engineering lead. Review the supplied repository and recommend where the engineering team should focus.

We are interested in whether you can identify the technical issues that matter most, connect them to business outcomes, and sequence investment while the company continues shipping. This is not an implementation exercise or a request for a comprehensive technical roadmap.

## Company and system context

The company supports 20 healthcare-provider customers, approximately 6,000 active patients per month, 50,000–75,000 monthly visits, and 1–2 million historical visits. The product covers intake, patient documentation, billing and claims, month-end close, cash application, and reporting.

The application is a TypeScript modular monolith backed by PostgreSQL. It handles protected health information and financial data, deploys frequently, and has no regular maintenance windows. Assume four engineers, including the engineering lead, can contribute materially to the priorities below while the rest of the team supports customers and maintains the product.

## Current business priorities

### Launch a useful AI employee capability in six weeks

A competitor has launched an “AI employee,” and the company is beginning to lose deals. Leadership wants a credible capability in customers’ hands within six weeks. Possible jobs include finding billing blockers, identifying missing documentation, explaining operational changes, drafting claim corrections, and taking approved follow-up actions.

The request is intentionally broad. The team must select a narrow initial use case that creates customer value and can be delivered safely, with appropriate permissions, auditability, and measurement.

### Begin enterprise onboarding in twelve weeks

A strategically important customer will begin a phased rollout in twelve weeks. It needs hierarchical organizations and locations, advanced and temporary permissions, permission-aware reports and exports, custom fields, customer-specific product edge cases, and a limited ability to trigger workflows from product activity.

Some needs may justify reusable platform capabilities; others may be configuration or temporary implementation work. The team cannot build every generalized platform before onboarding starts.

### Protect customer trust and improve performance

Numbers for closed accounting months can change after insurance, rates, visits, or payments are updated. A closed month must remain reproducible, and later corrections must appear explicitly rather than silently rewriting history.

The application is also slow. Common pages take 3–6 seconds, some requests issue hundreds of queries, large reports can time out, and common metrics disagree. The enterprise customer also wants deeper custom reporting. Improvements must preserve correctness, access controls, and auditability.

## Constraints

- The AI release is expected in six weeks; enterprise onboarding begins in twelve weeks.
- The application must remain live during migration, and existing APIs and integrations cannot all change at once.
- Historical claims and closed financial results must remain explainable.
- The workload is meaningful but modest; scale alone does not require a distributed rewrite.
- Leadership will not support a broad microservices rewrite or a multi-quarter feature freeze without unusually strong justification.
- You have incomplete information. State material assumptions and questions.

## Assignment

Spend no more than two hours reviewing the repository, then submit a concise recommendation with these three sections.

### 1. Core technical issues

Identify the small set of technical-debt issues you believe have the greatest business impact. We expect roughly three to five issue clusters, not an exhaustive audit.

For each, briefly describe:

- What you observed, with one or two useful file references
- The business or product consequence
- Why it is more important than issues you are not prioritizing

Group related symptoms when they share a root cause. We value a well-supported view of the system more than the number of findings.

### 2. What matters most

Rank the selected issues and explain how they affect the AI deadline, enterprise onboarding, financial trust, and product performance. Make the tradeoffs explicit:

- What must be addressed to hit the business goals
- What can be contained temporarily
- What should be deferred or intentionally left unchanged
- Which assumptions or product decisions could change your priorities

You are not expected to solve every business goal.

### 3. Directional sequence

Describe what you would do **first, next, and later**. Keep this at the level needed to explain the sequence:

- The immediate containment or narrow product slice you would ship
- The enabling technical investment you would begin alongside or immediately afterward
- The deeper structural work that becomes worthwhile later
- The important dependency or migration seam connecting those stages

We are looking for sequencing judgment, not a detailed project plan.

## Scope of the deliverable

Do not create a detailed roadmap, ticket breakdown, staffing plan, or estimate for every project. Do not design the complete future architecture. You are not expected to inspect every module or catalog every defect.

A concise, prioritized memo is preferable to a comprehensive spreadsheet. Diagrams or pseudocode are optional and should only be included if they clarify a key decision. There is no page or word limit, but please stop after two hours even if there is more you would like to investigate.

For important claims, make it clear whether they are directly observed, inferred, assumed, or need validation. No production implementation is required.

## Use of AI and other tools

Use of AI assistants is heavily encouraged. The exercise is designed with the expectation that candidates will use AI to navigate the repository, trace behavior, and organize findings. You may also use any normal engineering reference or analysis tools.

You do not need to describe or disclose how you used AI. You remain responsible for your conclusions and should be prepared to discuss them.

## Follow-up discussion

The take-home will be followed by a 45-minute working session. We will discuss your top priorities, inspect selected repository evidence, and go deeper on one or two choices, including how you might implement or migrate them. We may introduce a changing business constraint.

## What we are evaluating

- Whether you find the few technical issues with the greatest business impact
- How clearly you connect technical choices to customer, revenue, trust, and delivery outcomes
- Whether your priorities and deferrals are well justified
- Whether your sequence balances near-term delivery with appropriate technical investment
- Technical depth and calibration in the areas you choose to investigate
- Clear, concise, evidence-based communication

There is no single expected answer or sequence.
