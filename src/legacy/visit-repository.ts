import { db } from "../lib/db.js";
import type { LegacyVisitAggregateRecord } from "./visit-records.js";

export class LegacyVisitRepository {
  /** Loads each visit's full hierarchy individually. Used by list mappings. */
  async findMany(visitIds: string[]): Promise<LegacyVisitAggregateRecord[]> {
    const records: LegacyVisitAggregateRecord[] = [];
    for (const visitId of visitIds) {
      const record = await this.findOne(visitId);
      if (record) records.push(record);
    }
    return records;
  }

  async findByPatient(patientId: string, limit = 100): Promise<LegacyVisitAggregateRecord[]> {
    const visits = await db.visit.findMany({
      where: { patientId, deletedAt: null },
      orderBy: { scheduledStart: "desc" },
      take: limit,
      select: { id: true },
    });
    return this.findMany(visits.map((visit) => visit.id));
  }

  async findOne(visitId: string): Promise<LegacyVisitAggregateRecord | null> {
    const visit = await db.visit.findUnique({ where: { id: visitId } });
    if (!visit) return null;
    const group = await db.visitGroup.findUniqueOrThrow({ where: { id: visit.visitGroupId } });
    const set = await db.visitSet.findUniqueOrThrow({ where: { id: group.visitSetId } });
    const noteCount = await db.clinicalNote.count({ where: { visitId } });
    const chargeCount = await db.charge.count({ where: { visitId } });
    return {
      set: {
        set_id: set.id, tenant_id: set.organizationId, patient_id: set.patientId, order_id: set.orderId,
        insurance_id: set.coverageId, authorization_id: set.authorizationId, service_code: set.serviceType,
        expected_visits: set.expectedVisitCount, set_status: set.status, billing_status: set.billingStatus,
      },
      group: {
        group_id: group.id, set_id: group.visitSetId, branch_id: group.branchId,
        clinician_id: group.primaryClinicianId, service_date: group.scheduledDate.toISOString(),
        service_code: group.serviceType, group_status: group.status,
        documentation_status: group.documentationStatus, billing_status: group.billingStatus,
      },
      visit: {
        visit_id: visit.id, group_id: visit.visitGroupId, patient_id: visit.patientId,
        clinician_id: visit.clinicianId, location_id: visit.locationId, insurance_id: visit.coverageId,
        scheduled_start: visit.scheduledStart.toISOString(), scheduled_end: visit.scheduledEnd.toISOString(),
        actual_start: visit.actualStart?.toISOString() ?? null, actual_end: visit.actualEnd?.toISOString() ?? null,
        status: visit.status,
      },
      noteCount,
      chargeCount,
    };
  }
}
