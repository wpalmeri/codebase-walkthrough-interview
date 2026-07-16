import { db } from "../lib/db.js";

export async function getOrderSummary(orderId: string) {
  const order = await db.serviceOrder.findUniqueOrThrow({
    where: { id: orderId },
    include: {
      details: true,
      episode: { include: { patient: { include: { profile: true, demographics: true } } } },
      visitSets: { include: { authorization: true, groups: { include: { visits: { include: { notes: true, charges: true } } } } } },
    },
  });
  const visitCount = await db.visit.count({ where: { visitGroup: { visitSet: { orderId } }, deletedAt: null } });
  const completedCount = await db.visit.count({ where: { visitGroup: { visitSet: { orderId } }, status: "COMPLETED", deletedAt: null } });
  return { order, visitCount, completedCount };
}
