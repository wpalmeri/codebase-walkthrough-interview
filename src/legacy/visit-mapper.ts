import type { LegacyVisitAggregateRecord } from "./visit-records.js";
import type { VisitDomainModel } from "../visits/domain.js";

export function legacyAggregateToDomain(record: LegacyVisitAggregateRecord): VisitDomainModel {
  return {
    id: record.visit.visit_id,
    organizationId: record.set.tenant_id,
    patientId: record.visit.patient_id || record.set.patient_id,
    orderId: record.set.order_id,
    visitSetId: record.set.set_id,
    visitGroupId: record.group.group_id,
    branchId: record.group.branch_id,
    clinicianId: record.visit.clinician_id ?? record.group.clinician_id,
    coverageId: record.visit.insurance_id ?? record.set.insurance_id,
    authorizationId: record.set.authorization_id,
    serviceType: record.group.service_code ?? record.set.service_code,
    scheduledStart: new Date(record.visit.scheduled_start),
    scheduledEnd: new Date(record.visit.scheduled_end),
    actualStart: record.visit.actual_start ? new Date(record.visit.actual_start) : null,
    actualEnd: record.visit.actual_end ? new Date(record.visit.actual_end) : null,
    status: record.visit.status,
    documentationStatus: record.group.documentation_status,
    billingStatus: record.group.billing_status !== "NOT_READY" ? record.group.billing_status : record.set.billing_status,
    hasDocumentation: record.noteCount > 0,
    hasCharges: record.chargeCount > 0,
  };
}
