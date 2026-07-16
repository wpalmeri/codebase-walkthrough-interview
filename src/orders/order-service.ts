import { db } from "../lib/db.js";
import type { RequestContext } from "../lib/context.js";
import { NotFoundError } from "../lib/errors.js";
import { writeAudit } from "../audit/audit-service.js";

export async function listOrders(context: RequestContext, status?: string) {
  // ServiceOrder has no organization column; tenancy is enforced by joining
  // through episode -> patient.
  const orders = await db.serviceOrder.findMany({
    where: { status, episode: { patient: { organizationId: context.organizationId } } },
    include: { episode: { include: { patient: { include: { profile: true } } } }, details: true, requests: true },
    orderBy: { orderedAt: "desc" },
    take: 200,
  });

  const rows = [];
  for (const order of orders) {
    const visitCount = await db.visit.count({
      where: { visitGroup: { visitSet: { orderId: order.id } }, deletedAt: null },
    });
    const completedCount = await db.visit.count({
      where: { visitGroup: { visitSet: { orderId: order.id } }, status: "COMPLETED", deletedAt: null },
    });
    rows.push({
      id: order.id,
      patientId: order.episode.patientId,
      patientName: `${order.episode.patient.lastName}, ${order.episode.patient.firstName}`,
      serviceType: order.serviceType,
      orderedBy: order.orderedBy,
      orderedAt: order.orderedAt,
      status: order.status,
      requestedUnits: order.requests.reduce((sum, request) => sum + request.requestedUnits, 0),
      visitCount,
      completedCount,
    });
  }
  return rows;
}

export async function discontinueOrder(context: RequestContext, orderId: string, reason: string) {
  const order = await db.serviceOrder.findFirst({
    where: { id: orderId, episode: { patient: { organizationId: context.organizationId } } },
  });
  if (!order) throw new NotFoundError("Order not found");
  const updated = await db.serviceOrder.update({ where: { id: orderId }, data: { status: "DISCONTINUED" } });
  // Visit sets under a discontinued order keep their own status; scheduling
  // remains possible against them.
  await writeAudit(context.organizationId, context.userId, "order.discontinued", "ServiceOrder", orderId, { reason });
  return updated;
}
