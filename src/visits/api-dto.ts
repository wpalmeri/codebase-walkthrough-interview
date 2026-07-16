import type { VisitDomainModel } from "./domain.js";
import { deliveredMinutes } from "./domain.js";

export interface VisitResponseDto {
  id: string;
  patientId: string;
  orderId: string;
  visitSetId: string;
  visitGroupId: string;
  branchId: string;
  serviceType: string;
  startsAt: string;
  endsAt: string;
  status: string;
  deliveredMinutes: number | null;
  documentation: { status: string; exists: boolean };
  billing: { status: string; hasCharges: boolean };
}

export function domainToVisitResponse(visit: VisitDomainModel): VisitResponseDto {
  return {
    id: visit.id,
    patientId: visit.patientId,
    orderId: visit.orderId,
    visitSetId: visit.visitSetId,
    visitGroupId: visit.visitGroupId,
    branchId: visit.branchId,
    serviceType: visit.serviceType,
    startsAt: visit.scheduledStart.toISOString(),
    endsAt: visit.scheduledEnd.toISOString(),
    status: visit.status,
    deliveredMinutes: deliveredMinutes(visit),
    documentation: { status: visit.documentationStatus, exists: visit.hasDocumentation },
    billing: { status: visit.billingStatus, hasCharges: visit.hasCharges },
  };
}
