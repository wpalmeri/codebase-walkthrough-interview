/**
 * Actions a workflow can perform. Today this is descriptive only — the runner
 * dispatches on action.type with a switch and does not validate against this
 * list, so a definition can reference an action type that isn't here (it
 * falls through to a no-op) or pass arbitrary fields. The intended end state
 * is a closed catalog the runner enforces.
 */

export interface ActionDescriptor {
  type: string;
  label: string;
  sideEffect: "internal" | "external";
  description: string;
  argSchema: Record<string, string>;
}

export const ACTION_CATALOG: ActionDescriptor[] = [
  {
    type: "create_task",
    label: "Create task",
    sideEffect: "internal",
    description: "Creates a TaskRecord assigned to a queue or user.",
    argSchema: { title: "string", assigneeId: "string?", priority: "string?", queue: "string?" },
  },
  {
    type: "notify_supervisor",
    label: "Notify supervisor",
    sideEffect: "internal",
    description: "Creates a high-priority task for the branch supervisor.",
    argSchema: { message: "string", branchId: "string?" },
  },
  {
    type: "webhook",
    label: "Call webhook",
    sideEffect: "external",
    description: "POSTs the event payload to an arbitrary URL. No allowlist.",
    argSchema: { url: "string", secret: "string?", retry: "string?" },
  },
  {
    type: "update_crm",
    label: "Update CRM",
    sideEffect: "external",
    description: "Pushes a record to the customer CRM simulator.",
    argSchema: { recordType: "string" },
  },
  {
    type: "require_review",
    label: "Require finance review",
    sideEffect: "internal",
    description: "Flags the source record and creates a finance review task.",
    argSchema: { threshold: "number?" },
  },
  {
    type: "emit",
    label: "Emit domain event",
    sideEffect: "internal",
    description: "Emits another domain event; can re-trigger workflows (weak loop guard).",
    argSchema: { eventName: "string" },
  },
  {
    type: "audit",
    label: "Write audit note",
    sideEffect: "internal",
    description: "Writes an audit event only.",
    argSchema: { message: "string" },
  },
];

export function describeAction(type: string): ActionDescriptor | undefined {
  return ACTION_CATALOG.find((action) => action.type === type);
}
