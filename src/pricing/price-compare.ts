import { db } from "../lib/db.js";
import { legacyVisitPrice } from "./legacy-price-resolver.js";
import { displayScheduledPrice } from "./scheduling-price.js";
import { completionValue } from "../visits/completion-price.js";
import { quotePrice } from "./pricing-service.js";

/**
 * Debug endpoint comparing what each pricing path returns for one visit.
 * Added while chasing INC-1120; left in because support uses it weekly.
 */
export async function comparePricingPaths(visitId: string) {
  const visit = await db.visit.findUniqueOrThrow({
    where: { id: visitId },
    include: { patient: true, visitGroup: { include: { visitSet: true } } },
  });

  const results: Record<string, { amount: number | string; source: string } | { error: string }> = {};

  const attempts: Array<[string, () => Promise<{ amount: unknown; source?: string }>]> = [
    ["legacyChargePath", () => legacyVisitPrice(visitId)],
    ["schedulingDisplay", () => displayScheduledPrice(visitId)],
    ["completionValue", () => completionValue(visitId)],
    [
      "pricingService",
      async () => {
        const clinician = visit.clinicianId ? await db.clinicianProfile.findUnique({ where: { userId: visit.clinicianId } }) : null;
        const quote = await quotePrice({
          organizationId: visit.visitGroup.visitSet.organizationId,
          coverageId: visit.coverageId ?? visit.visitGroup.visitSet.coverageId ?? visit.patient.currentCoverageId!,
          serviceType: visit.serviceType ?? visit.visitGroup.serviceType ?? visit.visitGroup.visitSet.serviceType,
          serviceDate: visit.actualStart ?? visit.scheduledStart,
          locationId: visit.locationId,
          credential: clinician?.credential,
        });
        return { amount: quote.amount.toString(), source: quote.source };
      },
    ],
  ];

  for (const [name, run] of attempts) {
    try {
      const result = await run();
      results[name] = { amount: result.amount as number | string, source: (result.source as string) ?? name };
    } catch (error) {
      results[name] = { error: error instanceof Error ? error.message : String(error) };
    }
  }

  const amounts = Object.values(results)
    .filter((entry): entry is { amount: number | string; source: string } => "amount" in entry)
    .map((entry) => Number(entry.amount));
  const spread = amounts.length > 1 ? Math.max(...amounts) - Math.min(...amounts) : 0;

  return { visitId, results, agreement: { amounts, spread: Math.round(spread * 100) / 100, allAgree: spread < 0.01 } };
}
