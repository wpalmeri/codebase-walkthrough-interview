# AI Employee Discovery Notes

Discovery notes for a prospective "AI employee" capability. This document
captures the commercial context, the customer jobs heard in interviews, and the
open questions the team needs to answer before committing to a first release. It
describes what customers are asking for and what already exists as a prototype;
it does not prescribe a design.

## Commercial context

- Three recent prospects asked whether the product offers an "AI employee." One
  selected a competitor whose demonstration showed an agent monitoring billing
  operations and taking corrective action on its own.
- Leadership's framing is broad: "give every customer an AI employee that can
  monitor operations and perform work on their behalf." Sales wants a credible
  production capability on a short timeline.
- The intent is an assistant that both answers operational questions and does
  work — not only a chat surface over the data.

## Current prototype

An experimental implementation exists under `src/ai-employee`. It is included so
discovery conversations are grounded in something runnable, and it establishes the
shape of the problem rather than a shippable answer:

- A deterministic local model adapter (`fake-model.ts`) stands in for a real
  provider; no API key or network call is required.
- The agent builds an operations context, renders a prompt, calls the model, runs
  any tool calls the model requested, and persists a proposed action
  (`operations-agent.ts`).
- Tools read ORM tables directly and return whole rows; read tools and one write
  tool (`resubmit_claim`) share a single registry (`tools.ts`).
- Runs, tool invocations, and proposed actions are recorded on `AiRun`,
  `AiToolInvocation`, and `AiProposedAction`.
- Proposed actions can be executed; executing performs real work and flips the
  action's status.

The prototype currently loads full patient records and note bodies into the
prompt, logs the prompt to the general application log, runs under a broad
service identity, treats model output as trusted, and resolves some action
arguments to "the first matching record" at execution time. These behaviors are
the substance of the open questions below.

## Customer jobs heard in interviews

### Revenue-cycle manager

- "Tell me every visit that cannot go out on a claim today, and why."
- "Draft the fix for obvious rejection reasons, but show me before resubmitting."
- "Resubmit the claim once I approve it."
- "Explain why expected revenue moved from last week."

### Clinical supervisor

- "Find completed visits with missing or incomplete documentation."
- "Route follow-up to the right clinician or manager."
- "Summarize the unresolved documentation backlog each morning."

### Branch operator

- "Tell me which orders will exceed their authorization this week."
- "Assign the work to the right person, or open the task for me."
- "Run the workflow we already use for this, on my behalf."
- "Answer using only the branches I oversee."

Across personas, the jobs fall into a few families: **find** (unbillable visits,
missing documentation, at-risk authorizations), **explain** (why a number
changed, why a claim was priced or rejected as it was), **draft** (a correction,
a follow-up, a task), and **act** (resubmit a claim, assign a task, run a
customer workflow). The "find" and "explain" jobs are read-only; the "act" jobs
change customer or payer state.

## Open questions

### Scope and permissions

- What may the assistant read, and what may it change? Where is the boundary
  between drafting and doing?
- Whose permissions does it inherit — the requesting user's, or a service
  identity? The prototype uses an org-wide identity, which is broader than any
  single user.
- Should answers be limited to the branches or region the requester oversees?

### Human control

- Which actions always require explicit human approval, and what does approval
  need to verify (that the approver is entitled to the underlying action, and that
  what they approved is what runs)?
- Is drafting useful on its own, without automatic execution, for a first release?

### Data handling

- How much data should enter the prompt? What is the minimization rule for PHI,
  and which fields are never sent?
- Where may prompts and responses be logged, given they can contain PHI?

### Trust and safety

- How is untrusted content in the data (note text, patient-supplied fields)
  prevented from steering the agent (prompt injection)?
- How is model output validated before it drives a tool call or an action?

### Correctness and reliability

- Are actions idempotent? Resubmitting a claim is not, so a repeat or retry can
  double-submit.
- How are answers tied to the specific records behind them, so a user can verify
  them (provenance)?
- What evaluation set determines whether the assistant is good enough to ship, and
  what error rate is acceptable for a suggestion versus an action?
- What is the acceptable cost and latency per resolved task?
- What is the failure behavior when the model is wrong, unavailable, or slow —
  does the job stop, queue, or fall back to a human?

### Auditability

- Every read and action needs to be attributable and reviewable after the fact.
  What must be captured on each run for compliance, and for how long?

## Framing for the first release

The first release decision is less about the model and more about the boundary:
which single persona and job to support, whether that job is read-only or allowed
to act, and what approval and audit wrap any action. A narrow, well-audited
"find and explain, draft on request, act only with verified approval" slice is
the most likely starting point; the open questions above are what turn that into
a concrete scope.
