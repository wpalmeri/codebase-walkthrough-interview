import { db } from "../lib/db.js";

export async function explainVisitPrice(visitId: string) {
  const visit = await db.visit.findUniqueOrThrow({ include: { patient: { include: { coverages: true } }, visitGroup: { include: { visitSet: true } } }, where: { id: visitId } });
  const coverage = visit.patient.coverages.find((item) => item.id === visit.patient.currentCoverageId) ?? visit.patient.coverages[0];
  const rate = await db.payerRate.findFirst({ where: { serviceType: visit.visitGroup.visitSet.serviceType, contract: { payerId: coverage?.payerId, organizationId: visit.visitGroup.visitSet.organizationId } } });
  return { answer: `The expected price is $${Number(rate?.amount ?? 100).toFixed(2)} based on the patient's current ${coverage?.planName ?? "default"} plan.`, evidence: { patientId: visit.patientId, rateId: rate?.id } };
}
