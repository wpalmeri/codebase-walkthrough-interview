import type { VisitStatus } from "@prisma/client";

export interface LegacyVisitSetRecord {
  set_id: string;
  tenant_id: string;
  patient_id: string;
  order_id: string;
  insurance_id: string | null;
  authorization_id: string | null;
  service_code: string;
  expected_visits: number | null;
  set_status: string;
  billing_status: string;
}

export interface LegacyVisitGroupRecord {
  group_id: string;
  set_id: string;
  branch_id: string;
  clinician_id: string | null;
  service_date: string;
  service_code: string | null;
  group_status: string;
  documentation_status: string;
  billing_status: string;
}

export interface LegacyVisitRecord {
  visit_id: string;
  group_id: string;
  patient_id: string;
  clinician_id: string | null;
  location_id: string | null;
  insurance_id: string | null;
  scheduled_start: string;
  scheduled_end: string;
  actual_start: string | null;
  actual_end: string | null;
  status: VisitStatus;
}

export interface LegacyVisitAggregateRecord {
  set: LegacyVisitSetRecord;
  group: LegacyVisitGroupRecord;
  visit: LegacyVisitRecord;
  noteCount: number;
  chargeCount: number;
}
