import { db } from "../lib/db.js";

export async function previewOrderValue(orderId: string) {
  const order = await db.serviceOrder.findUniqueOrThrow({ include: { episode: { include: { patient: true } }, visitSets: true, requests: true }, where: { id: orderId } });
  const coverage = await db.insuranceCoverage.findUniqueOrThrow({ where: { id: order.episode.patient.currentCoverageId! } });
  const rate = await db.payerRate.findFirstOrThrow({ where: { serviceType: order.serviceType, contract: { payerId: coverage.payerId } } });
  const requested = order.requests.reduce((sum, request) => sum + request.requestedUnits, 0);
  return { orderId, estimatedValue: Number(rate.amount) * requested, rateId: rate.id, requested };
}
