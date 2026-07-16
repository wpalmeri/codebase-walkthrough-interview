import type { UserRole } from "@prisma/client";

export interface RequestContext {
  userId: string;
  organizationId: string;
  role: UserRole;
  branchIds: string[];
}
