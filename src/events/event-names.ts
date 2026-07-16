// Event name constants. Naming predates any convention: some modules emit
// dot.case, some emit PascalCase, and a few emit snake_case. Consumers match
// on exact strings.

export const EVENT_VISIT_SCHEDULED = "visit.scheduled";
export const EVENT_VISIT_COMPLETED = "visit.completed";
export const EVENT_VISIT_CANCELLED = "VisitCancelled";
export const EVENT_VISIT_MOVED = "visit.moved_branch";

export const EVENT_NOTE_SIGNED = "note.signed";
export const EVENT_NOTE_AMENDED = "NoteAmended";

export const EVENT_PATIENT_CREATED = "patient.created";
export const EVENT_PATIENT_MERGED = "patient_merged";

export const EVENT_CHARGE_POSTED = "charge.posted";
export const EVENT_CLAIM_SUBMITTED = "claim_submitted";
export const EVENT_CLAIM_REJECTED = "claim.rejected";
export const EVENT_CLAIM_PAID = "ClaimPaid";

export const EVENT_PAYMENT_POSTED = "payment.posted";
export const EVENT_PAYMENT_REVERSED = "payment.reversed";

export const EVENT_PERIOD_CLOSED = "accounting.period_closed";
export const EVENT_AUTH_NEAR_LIMIT = "authorization.near_limit";

export const EVENT_TASK_CREATED = "task.created";
export const EVENT_AI_ACTION_EXECUTED = "ai.action_executed";
