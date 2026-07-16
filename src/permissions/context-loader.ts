import { db } from "../lib/db.js";
import type { RequestContext } from "../lib/context.js";
import { NotFoundError } from "../lib/errors.js";

export async function loadContext(userId: string): Promise<RequestContext> {
  const user = await db.user.findUnique({ include: { branchAccess: true }, where: { id: userId } });
  if (!user) throw new NotFoundError("User not found");
  return {
    userId: user.id,
    organizationId: user.organizationId,
    role: user.role,
    branchIds: user.branchAccess.filter((access) => !access.expiresAt || access.expiresAt > new Date()).map((access) => access.branchId),
  };
}
