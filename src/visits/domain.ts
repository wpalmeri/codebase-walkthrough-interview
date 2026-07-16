import type { VisitStatus } from "@prisma/client";

export interface VisitDomainModel {
  id: string;
  organizationId: string;
  patientId: string;
  orderId: string;
  visitSetId: string;
  visitGroupId: string;
  branchId: string;
  clinicianId: string | null;
  coverageId: string | null;
  authorizationId: string | null;
  serviceType: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  actualStart: Date | null;
  actualEnd: Date | null;
  status: VisitStatus;
  documentationStatus: string;
  billingStatus: string;
  hasDocumentation: boolean;
  hasCharges: boolean;
}

export function deliveredMinutes(visit: VisitDomainModel): number | null {
  if (!visit.actualStart || !visit.actualEnd) return null;
  return Math.round((visit.actualEnd.getTime() - visit.actualStart.getTime()) / 60_000);
}

export function isOperationallyComplete(visit: VisitDomainModel): boolean {
  return visit.status === "COMPLETED" && Boolean(visit.actualStart && visit.actualEnd);
}
