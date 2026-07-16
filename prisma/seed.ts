import { Prisma, PrismaClient, UserRole, VisitStatus } from "@prisma/client";

const db = new PrismaClient();
const day = 86_400_000;
const now = new Date("2025-06-15T12:00:00.000Z");

function date(offsetDays: number, hour = 10): Date {
  const value = new Date(now.getTime() + offsetDays * day);
  value.setUTCHours(hour, 0, 0, 0);
  return value;
}

// Every table is truncated by name so repeated seeds are deterministic even
// for tables with no FK path back to Organization (StandardRate, FeatureFlag,
// JobRecord, AnalyticsEvent, RemittanceFile, etc. reference org by string).
const ALL_TABLES = [
  "Organization", "Region", "Branch", "Team", "TeamMembership", "Location",
  "User", "UserBranch", "ClinicianProfile", "DelegatedAccess",
  "Patient", "PatientProfile", "PatientDemographics", "PatientAssignment", "PatientMerge",
  "PossiblePatientMatch", "ReferralSource", "Referral",
  "InsuranceCoverage", "EligibilityCheck", "CareEpisode", "ServiceOrder", "OrderDetails",
  "ServiceRequest", "Authorization", "VisitSet", "VisitGroup", "Visit", "VisitStatusHistory",
  "NoteTemplate", "ClinicalNote", "NoteSignature", "NoteAmendment",
  "Payer", "PayerContract", "PayerRate", "StandardRate",
  "Charge", "ChargeLine", "Claim", "ClaimLine", "ClaimSubmissionAttempt", "ClaimRejection", "ClaimStatusHistory",
  "PatientStatement", "StatementBatch",
  "AccountingPeriod", "PeriodAdjustment", "FinancialPosting",
  "Payment", "CashApplication", "RemittanceFile", "RemittanceLine",
  "AuditEvent", "AnalyticsEvent", "DomainEvent",
  "WorkflowDefinition", "WorkflowExecution", "WebhookEndpoint", "WebhookDelivery",
  "TaskRecord", "JobRecord", "FeatureFlag", "IntegrationSyncState",
  "ReportDefinition", "ReportRun", "ScheduledExport",
  "CustomFieldDefinition", "CustomFieldValue",
  "AiConversation", "AiRun", "AiToolInvocation", "AiProposedAction",
];

async function reset(): Promise<void> {
  const list = ALL_TABLES.map((table) => `"${table}"`).join(", ");
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

async function main(): Promise<void> {
  await reset();

  const northstar = await db.organization.create({
    data: { id: "org_northstar", slug: "northstar-home-health", name: "Northstar Home Health" },
  });
  const lakeside = await db.organization.create({
    data: { id: "org_lakeside", slug: "lakeside-care", name: "Lakeside Care Services" },
  });

  const west = await db.region.create({
    data: { id: "region_west", organizationId: northstar.id, name: "Western Region" },
  });
  const east = await db.region.create({
    data: { id: "region_east", organizationId: northstar.id, name: "Eastern Region" },
  });
  const branches = await Promise.all([
    db.branch.create({ data: { id: "branch_sf", organizationId: northstar.id, regionId: west.id, name: "San Francisco" } }),
    db.branch.create({ data: { id: "branch_oak", organizationId: northstar.id, regionId: west.id, name: "Oakland" } }),
    db.branch.create({ data: { id: "branch_bos", organizationId: northstar.id, regionId: east.id, name: "Boston", timezone: "America/New_York" } }),
    db.branch.create({ data: { id: "branch_lake", organizationId: lakeside.id, name: "Main Office" } }),
  ]);

  await db.team.createMany({ data: [
    { id: "team_sf_a", branchId: "branch_sf", name: "Team A" },
    { id: "team_oak_a", branchId: "branch_oak", name: "Oakland Clinical" },
    { id: "team_bos_a", branchId: "branch_bos", name: "Boston Clinical" },
  ] });

  await db.user.createMany({ data: [
    { id: "user_admin", organizationId: northstar.id, email: "admin@northstar.example", displayName: "Avery Admin", role: UserRole.ADMIN },
    { id: "user_biller", organizationId: northstar.id, email: "billie@northstar.example", displayName: "Billie Revenue", role: UserRole.BILLER },
    { id: "user_clinician_sf", organizationId: northstar.id, email: "casey@northstar.example", displayName: "Casey Clinician", role: UserRole.CLINICIAN },
    { id: "user_viewer", organizationId: northstar.id, email: "victor@northstar.example", displayName: "Victor Viewer", role: UserRole.VIEWER },
    { id: "user_lakeside", organizationId: lakeside.id, email: "admin@lakeside.example", displayName: "Lakeside Admin", role: UserRole.ADMIN },
    { id: "user_ai", organizationId: northstar.id, email: "ai-service@internal.example", displayName: "AI Service", role: UserRole.ADMIN },
  ] });
  // Additional northstar clinicians and staff. These do not change the
  // patient/claim/period/workflow aggregates the UI tests assert, but they
  // give scheduling, productivity, and permissions real rosters to work with.
  await db.user.createMany({ data: [
    { id: "user_clinician_oak", organizationId: northstar.id, email: "dana@northstar.example", displayName: "Dana Nurse", role: UserRole.CLINICIAN, credential: "RN" },
    { id: "user_clinician_bos", organizationId: northstar.id, email: "emerson@northstar.example", displayName: "Emerson PT", role: UserRole.CLINICIAN, credential: "PT" },
    { id: "user_clinician_lvn", organizationId: northstar.id, email: "frankie@northstar.example", displayName: "Frankie LVN", role: UserRole.CLINICIAN, credential: "LVN" },
    { id: "user_biller_2", organizationId: northstar.id, email: "gale@northstar.example", displayName: "Gale Billing", role: UserRole.BILLER },
    { id: "user_supervisor", organizationId: northstar.id, email: "harper@northstar.example", displayName: "Harper Supervisor", role: UserRole.ADMIN, title: "Regional Supervisor" },
  ] });
  await db.userBranch.createMany({ data: [
    { userId: "user_clinician_sf", branchId: "branch_sf" },
    { userId: "user_viewer", branchId: "branch_oak" },
    { userId: "user_clinician_oak", branchId: "branch_oak" },
    { userId: "user_clinician_bos", branchId: "branch_bos" },
    { userId: "user_clinician_lvn", branchId: "branch_sf" },
    { userId: "user_biller_2", branchId: "branch_sf" },
    // Temporary cross-branch grant that expired last month but is never cleaned up.
    { userId: "user_clinician_oak", branchId: "branch_sf", expiresAt: date(-30) },
    // Supervisor gets every branch, granted individually (no region-scope support).
    { userId: "user_supervisor", branchId: "branch_sf" },
    { userId: "user_supervisor", branchId: "branch_oak" },
    { userId: "user_supervisor", branchId: "branch_bos" },
  ] });
  await db.clinicianProfile.createMany({ data: [
    { userId: "user_clinician_sf", credential: "RN", discipline: "Skilled Nursing", npi: "1000000001", hourlyCostCents: 5200 },
    { userId: "user_clinician_oak", credential: "RN", discipline: "Skilled Nursing", npi: "1000000002", hourlyCostCents: 5100 },
    { userId: "user_clinician_bos", credential: "PT", discipline: "Physical Therapy", npi: "1000000003", hourlyCostCents: 5800 },
    { userId: "user_clinician_lvn", credential: "LVN", discipline: "Skilled Nursing", npi: "1000000004", hourlyCostCents: 3800 },
  ] });
  await db.location.createMany({ data: [
    { id: "loc_sf_main", organizationId: northstar.id, branchId: "branch_sf", name: "SF Clinic", kind: "FACILITY", city: "San Francisco", state: "CA" },
    { id: "loc_oak_main", organizationId: northstar.id, branchId: "branch_oak", name: "Oakland Clinic", kind: "FACILITY", city: "Oakland", state: "CA" },
    { id: "loc_home", organizationId: northstar.id, name: "Patient Home", kind: "HOME" },
  ] });
  await db.teamMembership.createMany({ data: [
    { teamId: "team_sf_a", userId: "user_clinician_sf", role: "LEAD" },
    { teamId: "team_sf_a", userId: "user_clinician_lvn", role: "MEMBER" },
    { teamId: "team_oak_a", userId: "user_clinician_oak", role: "LEAD" },
    { teamId: "team_bos_a", userId: "user_clinician_bos", role: "LEAD" },
  ] });
  // Delegated access row that nothing enforces yet (the table exists ahead of the feature).
  await db.delegatedAccess.create({ data: {
    organizationId: northstar.id, fromUserId: "user_admin", toUserId: "user_biller_2",
    scope: { claims: true, payments: true }, startsAt: date(-10), endsAt: date(20), createdBy: "user_admin",
  } });

  const payer = await db.payer.create({ data: { id: "payer_acme", name: "Acme Health Plan", code: "ACME" } });
  await db.payer.create({ data: { id: "payer_federal", name: "Federal Health", code: "FHP", payerType: "MEDICARE" } });
  await db.payer.create({ data: { id: "payer_blue", name: "Blue Shield Regional", code: "BSR", payerType: "COMMERCIAL" } });
  const contract = await db.payerContract.create({ data: {
    id: "contract_acme_v1", payerId: payer.id, organizationId: northstar.id,
    name: "Acme Standard 2025", effectiveFrom: new Date("2025-01-01T00:00:00Z"), version: 1,
  } });
  await db.payerRate.createMany({ data: [
    { id: "rate_rn", contractId: contract.id, serviceType: "SKILLED_NURSING", amount: new Prisma.Decimal("135.00"), effectiveFrom: new Date("2025-01-01T00:00:00Z"), priority: 0 },
    { id: "rate_rn_sf", contractId: contract.id, serviceType: "SKILLED_NURSING", locationId: "branch_sf", amount: new Prisma.Decimal("149.50"), effectiveFrom: new Date("2025-04-01T00:00:00Z"), priority: 10 },
    { id: "rate_pt", contractId: contract.id, serviceType: "PHYSICAL_THERAPY", amount: new Prisma.Decimal("122.75"), effectiveFrom: new Date("2025-01-01T00:00:00Z") },
    { id: "rate_aide", contractId: contract.id, serviceType: "HOME_HEALTH_AIDE", amount: new Prisma.Decimal("38.333"), unit: "HOUR", effectiveFrom: new Date("2025-01-01T00:00:00Z") },
  ] });
  // A second, higher-precedence Acme contract effective mid-year with no end
  // date on the first. Pricing paths that order by precedence see these rates;
  // paths that grab the first active row by id do not — a source of the
  // estimate/charge/close disagreements described in the pricing notes.
  const contractV2 = await db.payerContract.create({ data: {
    id: "contract_acme_v2", payerId: payer.id, organizationId: northstar.id,
    name: "Acme Amended 2025-H2", kind: "AMENDMENT", precedence: 10,
    effectiveFrom: new Date("2025-07-01T00:00:00Z"), version: 2,
  } });
  await db.payerRate.createMany({ data: [
    { id: "rate_rn_v2", contractId: contractV2.id, serviceType: "SKILLED_NURSING", amount: new Prisma.Decimal("142.00"), effectiveFrom: new Date("2025-07-01T00:00:00Z"), priority: 0 },
    { id: "rate_pt_v2", contractId: contractV2.id, serviceType: "PHYSICAL_THERAPY", amount: new Prisma.Decimal("128.50"), effectiveFrom: new Date("2025-07-01T00:00:00Z") },
  ] });
  // Fallback "standard" rates a couple of pricing paths use when no contract matches.
  await db.standardRate.createMany({ data: [
    { serviceType: "SKILLED_NURSING", amount: new Prisma.Decimal("120.00"), effectiveFrom: new Date("2025-01-01T00:00:00Z") },
    { serviceType: "PHYSICAL_THERAPY", amount: new Prisma.Decimal("110.00"), effectiveFrom: new Date("2025-01-01T00:00:00Z") },
    { serviceType: "HOME_HEALTH_AIDE", amount: new Prisma.Decimal("34.00"), unit: "HOUR", effectiveFrom: new Date("2025-01-01T00:00:00Z") },
    { serviceType: "OCCUPATIONAL_THERAPY", amount: new Prisma.Decimal("118.00"), effectiveFrom: new Date("2025-01-01T00:00:00Z") },
  ] });
  await db.noteTemplate.createMany({ data: [
    { id: "tmpl_sn", organizationId: northstar.id, name: "Skilled Nursing Visit", serviceType: "SKILLED_NURSING", version: 2, schema: { fields: [
      { key: "subjective", label: "Subjective", type: "longtext", required: true },
      { key: "objective", label: "Objective", type: "longtext", required: true },
      { key: "vitals_bp", label: "Blood Pressure", type: "text" },
      { key: "plan", label: "Plan", type: "longtext" },
    ] } },
    { id: "tmpl_pt", organizationId: northstar.id, name: "PT Evaluation", serviceType: "PHYSICAL_THERAPY", version: 1, schema: { fields: [
      { key: "assessment", label: "Assessment", type: "longtext", required: true },
      { key: "rom", label: "Range of Motion", type: "text" },
      { key: "goals", label: "Goals", type: "longtext" },
    ] } },
  ] });
  await db.featureFlag.createMany({ data: [
    { key: "ai_employee", description: "AI operational employee", enabledGlobally: true },
    { key: "report_builder_v2", description: "Governed report builder", enabledGlobally: false, organizationIds: ["org_evergreen"] },
    { key: "keyset_pagination", description: "Keyset pagination on visit list", enabledGlobally: false },
    { key: "pricing_service_charges", description: "Route charge creation through PricingService", enabledGlobally: false, organizationIds: ["org_lakeside"] },
    { key: "weekly_aging_buckets", description: "Weekly AR aging buckets", enabledGlobally: false, organizationIds: ["org_evergreen"] },
  ] });

  for (let p = 0; p < 36; p += 1) {
    const patientId = `patient_${p.toString().padStart(3, "0")}`;
    const coverageId = `coverage_${p.toString().padStart(3, "0")}`;
    await db.patient.create({ data: {
      id: patientId, organizationId: northstar.id, externalId: `NS-${1000 + p}`,
      firstName: ["Alex", "Jordan", "Morgan", "Riley", "Taylor", "Avery"][p % 6]!,
      lastName: `Patient${p.toString().padStart(2, "0")}`,
      dateOfBirth: new Date(Date.UTC(1940 + (p % 50), p % 12, 1 + (p % 20))),
      currentCoverageId: coverageId,
      profile: { create: { legalName: `Patient ${p}`, preferredName: p % 4 === 0 ? `P${p}` : null, phone: `415-555-${(1000 + p).toString()}` } },
      demographics: { create: { givenName: `Patient${p}`, familyName: `Family${p}`, birthDate: new Date(Date.UTC(1940 + (p % 50), p % 12, 1 + (p % 20))), language: p % 3 === 0 ? "es" : "en" } },
    } });
    await db.insuranceCoverage.create({ data: {
      id: coverageId, patientId, payerId: payer.id, memberId: `M${100000 + p}`,
      planName: "Acme Choice", effectiveFrom: new Date("2025-01-01T00:00:00Z"), verifiedAt: date(-90),
    } });
    const episodeId = `episode_${p}`;
    const orderId = `order_${p}`;
    const authorizationId = `auth_${p}`;
    await db.careEpisode.create({ data: { id: episodeId, patientId, name: "Home health episode", startedAt: date(-80 + p) } });
    await db.serviceOrder.create({ data: {
      id: orderId, episodeId, serviceType: p % 5 === 0 ? "PHYSICAL_THERAPY" : "SKILLED_NURSING",
      orderedBy: "Dr. Example", orderedAt: date(-75 + p),
      details: { create: { diagnosis: "Post-acute recovery", frequency: "3x weekly", durationWeeks: 8 } },
      requests: { create: { requestedUnits: 24, requestedStart: date(-70 + p), requestedEnd: date(20 + p) } },
    } });
    await db.authorization.create({ data: {
      id: authorizationId, coverageId, authorizationNumber: `AUTH-${5000 + p}`,
      serviceType: p % 5 === 0 ? "PHYSICAL_THERAPY" : "SKILLED_NURSING",
      maxVisits: p % 7 === 0 ? 3 : 24, effectiveFrom: date(-90), effectiveTo: date(90),
    } });
    const setId = `visit_set_${p}`;
    await db.visitSet.create({ data: {
      id: setId, organizationId: northstar.id, patientId, orderId, coverageId, authorizationId,
      serviceType: p % 5 === 0 ? "PHYSICAL_THERAPY" : "SKILLED_NURSING",
      expectedVisitCount: 24, startDate: date(-60 + p), status: "ACTIVE",
    } });

    const groupCount = p === 0 ? 3 : 1;
    for (let g = 0; g < groupCount; g += 1) {
      const groupId = `visit_group_${p}_${g}`;
      await db.visitGroup.create({ data: {
        id: groupId, visitSetId: setId, branchId: branches[p % 3]!.id,
        primaryClinicianId: "user_clinician_sf", scheduledDate: date(-20 + p + g),
        serviceType: p % 9 === 0 ? "SKILLED_NURSING" : null,
        status: "COMPLETED", documentationStatus: p % 6 === 0 ? "MISSING" : "SIGNED",
        billingStatus: p % 4 === 0 ? "NOT_READY" : "READY", sequenceNumber: g + 1,
      } });
      const visitsInGroup = p === 0 && g === 0 ? 3 : 1;
      for (let v = 0; v < visitsInGroup; v += 1) {
        const visitId = `visit_${p}_${g}_${v}`;
        const scheduled = date(-20 + p + g, 9 + v);
        await db.visit.create({ data: {
          id: visitId, visitGroupId: groupId, patientId,
          clinicianId: "user_clinician_sf", locationId: p === 7 ? "branch_oak" : branches[p % 3]!.id,
          coverageId: p % 8 === 0 ? coverageId : null,
          scheduledStart: scheduled, scheduledEnd: new Date(scheduled.getTime() + 60 * 60 * 1000),
          actualStart: scheduled, actualEnd: new Date(scheduled.getTime() + (45 + p % 30) * 60 * 1000),
          status: VisitStatus.COMPLETED, completedAt: new Date(scheduled.getTime() + 75 * 60 * 1000),
        } });
        if (p % 6 !== 0) {
          await db.clinicalNote.create({ data: {
            id: `note_${p}_${g}_${v}`, visitId, authorId: "user_clinician_sf",
            content: { subjective: "Patient reports improvement", objective: "Tolerated treatment" },
            status: "SIGNED", signedAt: new Date(scheduled.getTime() + 2 * 60 * 60 * 1000), signedBy: "user_clinician_sf",
          } });
        }
      }
    }
  }

  for (let p = 1; p <= 14; p += 1) {
    const visitId = `visit_${p}_0_0`;
    const amount = new Prisma.Decimal(p % 5 === 0 ? "122.75" : "135.00");
    const charge = await db.charge.create({ data: {
      id: `charge_${p}`, visitId, coverageId: `coverage_${p.toString().padStart(3, "0")}`,
      status: "POSTED", totalAmount: amount, postedAt: date(-18 + p),
      pricingSnapshot: p % 3 === 0 ? { rateId: p % 5 === 0 ? "rate_pt" : "rate_rn", amount: amount.toString(), policyVersion: 1 } : undefined,
      lines: { create: { id: `charge_line_${p}`, serviceCode: p % 5 === 0 ? "PHYSICAL_THERAPY" : "SKILLED_NURSING", units: 1, unitPrice: amount, amount } },
    }, include: { lines: true } });
    const status = p % 7 === 0 ? "REJECTED" : p % 4 === 0 ? "PAID" : p % 3 === 0 ? "ACCEPTED" : "SUBMITTED";
    const balance = status === "PAID" ? new Prisma.Decimal(0) : amount;
    const claim = await db.claim.create({ data: {
      id: `claim_${p}`, organizationId: northstar.id, patientId: `patient_${p.toString().padStart(3, "0")}`,
      payerId: payer.id, status, externalId: status === "REJECTED" ? null : `ACME-${9000 + p}`,
      totalAmount: amount, balanceAmount: balance, submittedAt: date(-15 + p), createdAt: date(-16 + p),
      lines: { create: { id: `claim_line_${p}`, chargeLineId: charge.lines[0]!.id, amount } },
      attempts: { create: { status, requestId: p % 2 === 0 ? `REQ-${p}` : null, response: { payerReference: `ACME-${9000 + p}` }, attemptedAt: date(-15 + p) } },
    } });
    if (status === "PAID") {
      const payment = await db.payment.create({ data: {
        id: `payment_${p}`, organizationId: northstar.id, externalId: `ERA-${7000 + p}`,
        payerId: payer.id, amount, unappliedAmount: 0, receivedAt: date(-5 + p), status: "POSTED",
      } });
      await db.cashApplication.create({ data: { paymentId: payment.id, claimId: claim.id, amount, appliedAt: date(-5 + p) } });
    }
  }

  const otherPatient = await db.patient.create({ data: {
    id: "patient_lakeside", organizationId: lakeside.id, firstName: "Leslie", lastName: "Lakeside",
    dateOfBirth: new Date("1955-03-03T00:00:00Z"),
  } });
  await db.auditEvent.create({ data: {
    organizationId: lakeside.id, actorId: "user_lakeside", action: "patient.created",
    resourceType: "Patient", resourceId: otherPatient.id, payload: { source: "intake" },
  } });

  await db.accountingPeriod.createMany({ data: [
    { id: "period_may", organizationId: northstar.id, year: 2025, month: 5 },
    { id: "period_june", organizationId: northstar.id, year: 2025, month: 6 },
  ] });
  await db.customFieldDefinition.createMany({ data: [
    { id: "field_risk", organizationId: northstar.id, entityType: "Patient", key: "risk_tier", label: "Risk Tier", dataType: "STRING", configuration: { allowed: ["low", "medium", "high"] } },
    { id: "field_referral", organizationId: northstar.id, entityType: "VisitSet", key: "referral_source", label: "Referral Source", dataType: "STRING", configuration: {} },
    { id: "field_fall_risk", organizationId: northstar.id, entityType: "Patient", key: "fall_risk_score", label: "Fall Risk Score", dataType: "NUMBER", configuration: {} },
  ] });
  // EAV values for a subset of patients. reporting joins these per row.
  await db.customFieldValue.createMany({ data: [
    { definitionId: "field_risk", entityType: "Patient", entityId: "patient_000", stringValue: "high" },
    { definitionId: "field_risk", entityType: "Patient", entityId: "patient_001", stringValue: "medium" },
    { definitionId: "field_risk", entityType: "Patient", entityId: "patient_002", stringValue: "low" },
    { definitionId: "field_fall_risk", entityType: "Patient", entityId: "patient_000", numberValue: new Prisma.Decimal("8.5") },
    // A value written under the old STRING type of a field later changed to NUMBER — stranded in stringValue.
    { definitionId: "field_fall_risk", entityType: "Patient", entityId: "patient_003", stringValue: "high" },
    { definitionId: "field_referral", entityType: "VisitSet", entityId: "visit_set_1", stringValue: "Dr. Chen — Cardiology" },
  ] });

  await db.workflowDefinition.create({ data: {
    id: "workflow_unsigned", organizationId: northstar.id, name: "Escalate unsigned visits",
    eventName: "visit.completed", condition: { field: "documentationStatus", op: "equals", value: "MISSING" },
    actions: [{ type: "webhook", url: "http://localhost:3000/simulators/crm", retry: "forever" }], enabled: true,
  } });

  await seedNorthstarRelations();
  await seedEvergreen();

  const patientCount = await db.patient.count();
  const orgCount = await db.organization.count();
  console.log(JSON.stringify({
    organizations: orgCount,
    patients: patientCount,
    primaryOrganizationId: northstar.id,
    enterpriseOrganizationId: "org_evergreen",
    samplePatientId: "patient_000",
    sampleVisitId: "visit_0_0_0",
  }, null, 2));
}

/**
 * Northstar relations that exercise the newer modules without changing the
 * aggregates the UI tests assert (patient/claim/period/workflow counts on
 * org_northstar stay exactly as phase 1 built them).
 */
async function seedNorthstarRelations(): Promise<void> {
  const org = "org_northstar";

  await db.referralSource.createMany({ data: [
    { id: "ref_src_chen", organizationId: org, name: "Dr. Chen Cardiology", kind: "PHYSICIAN" },
    { id: "ref_src_mercy", organizationId: org, name: "Mercy Hospital Discharge", kind: "FACILITY" },
  ] });
  await db.referral.createMany({ data: [
    { organizationId: org, sourceId: "ref_src_chen", serviceType: "SKILLED_NURSING", status: "NEW", notes: "auth # 4432 per Susan, pt prefers Tues/Thurs, secondary: UHC", assignedToId: "user_admin" },
    { organizationId: org, sourceId: "ref_src_mercy", serviceType: "PHYSICAL_THERAPY", status: "CONVERTED", patientId: "patient_005", convertedAt: date(-40) },
    { organizationId: org, sourceId: "ref_src_mercy", serviceType: "SKILLED_NURSING", status: "NEW", notes: "post-op knee, start ASAP" },
  ] });

  await db.taskRecord.createMany({ data: [
    { organizationId: org, title: "Sign visit note for Patient00", status: "OPEN", priority: "HIGH", patientId: "patient_000", visitId: "visit_0_0_0", assigneeId: "user_clinician_sf", source: "MANUAL" },
    { organizationId: org, title: "Rework rejected claim CO-16", status: "OPEN", priority: "HIGH", claimId: "claim_7", assigneeId: "user_biller", source: "WORKFLOW" },
    { organizationId: org, title: "Follow up on unapplied payment", status: "IN_PROGRESS", priority: "NORMAL", assigneeId: "user_biller_2", source: "MANUAL" },
    { organizationId: org, title: "Verify eligibility for new intake", status: "OPEN", priority: "LOW", source: "MANUAL", dueAt: date(-2) },
  ] });

  await db.patientAssignment.createMany({ data: [
    { patientId: "patient_000", userId: "user_clinician_sf", role: "PRIMARY", startedAt: date(-60) },
    { patientId: "patient_001", userId: "user_clinician_sf", role: "PRIMARY", startedAt: date(-55) },
    { patientId: "patient_002", userId: "user_clinician_oak", role: "PRIMARY", startedAt: date(-50) },
  ] });

  const endpoint = await db.webhookEndpoint.create({ data: {
    id: "wh_crm", organizationId: org, url: "http://localhost:3000/simulators/webhook",
    secret: "whsec_seededplaintextsecret01", eventNames: ["visit.completed", "claim.rejected"], createdBy: "user_admin",
  } });
  await db.webhookDelivery.createMany({ data: [
    { endpointId: endpoint.id, eventName: "visit.completed", payload: { visitId: "visit_1_0_0" }, status: "DELIVERED", attempts: 1, responseStatus: 200, lastAttemptAt: date(-3) },
    { endpointId: endpoint.id, eventName: "claim.rejected", payload: { claimId: "claim_7" }, status: "FAILED", attempts: 3, responseStatus: 500, lastAttemptAt: date(-1), nextRetryAt: date(0) },
  ] });

  await db.reportDefinition.createMany({ data: [
    { id: "rpt_visits_by_branch", organizationId: org, key: "visits_by_branch", name: "Visits by Branch", baseView: "VISITS", shared: true, createdBy: "user_admin",
      columns: [{ key: "patientName" }, { key: "branch" }, { key: "serviceType" }, { key: "status" }], filters: [{ field: "status", op: "equals", value: "COMPLETED" }], groupings: ["branch"], calculations: [{ key: "count", formula: "count", column: "id" }] },
    { id: "rpt_ar", organizationId: org, key: "ar_by_payer", name: "AR by Payer", baseView: "CLAIMS", shared: true, createdBy: "user_biller",
      columns: [{ key: "payerCode" }, { key: "balanceAmount" }], groupings: ["payerCode"], calculations: [{ key: "balance", formula: "sum", column: "balanceAmount" }] },
  ] });
  await db.reportRun.createMany({ data: [
    { organizationId: org, definitionId: "rpt_visits_by_branch", reportKey: "visits_by_branch", requestedBy: "user_admin", status: "COMPLETED", durationMs: 4200, rowCount: 41, completedAt: date(-1) },
    { organizationId: org, reportKey: "revenue", requestedBy: "user_biller", status: "COMPLETED", durationMs: 9100, rowCount: 3, completedAt: date(-1) },
    { organizationId: org, reportKey: "cash", requestedBy: "user_biller", status: "FAILED", durationMs: 30000, error: "statement timeout", completedAt: date(-2) },
  ] });
  await db.scheduledExport.create({ data: {
    id: "sched_ar", organizationId: org, name: "Weekly AR export", reportKey: "ar_by_payer", cron: "0 6 * * 1",
    format: "CSV", destinationUrl: "http://localhost:3000/simulators/webhook", recipients: ["cfo@northstar.example"],
    createdBy: "user_biller", nextRunAt: date(1),
  } });

  // Financial postings + an explicit period adjustment (partial ledger adoption).
  await db.financialPosting.createMany({ data: [
    { organizationId: org, sourceType: "cash-application", sourceId: "seed-cash-1", postingDate: date(-5), amount: new Prisma.Decimal("135.00"), account: "1000-cash", metadata: { seeded: true } },
    { organizationId: org, sourceType: "cash-application", sourceId: "seed-cash-2", postingDate: date(-4), amount: new Prisma.Decimal("122.75"), account: "1000-cash", metadata: { seeded: true } },
  ] });
  await db.periodAdjustment.create({ data: {
    periodId: "period_may", description: "Retro payer rate correction (SN +$7)", amount: new Prisma.Decimal("210.00"), account: "4900-adjustments", createdBy: "user_admin",
  } });

  // A remittance file with a mix of matched and unmatched lines.
  await db.remittanceFile.create({ data: {
    id: "rem_file_1", organizationId: org, externalId: "REM-2025-06-01", payerId: "payer_acme",
    totalAmount: new Prisma.Decimal("405.00"), raw: { source: "seed" },
    lines: { create: [
      { claimExternalId: "ACME-9003", billedAmount: new Prisma.Decimal("135.00"), paidAmount: new Prisma.Decimal("135.00"), status: "UNMATCHED" },
      { claimExternalId: "ACME-9006", billedAmount: new Prisma.Decimal("135.00"), paidAmount: new Prisma.Decimal("108.00"), adjustmentAmount: new Prisma.Decimal("27.00"), adjustmentCode: "CO-45", status: "UNMATCHED" },
      { patientLastName: "Patient09", billedAmount: new Prisma.Decimal("122.75"), paidAmount: new Prisma.Decimal("122.75"), status: "UNMATCHED" },
    ] },
  } });

  // Some domain events left unprocessed for the worker/workflow demo, plus analytics.
  await db.domainEvent.createMany({ data: [
    { organizationId: org, eventName: "visit.completed", aggregateType: "Visit", aggregateId: "visit_2_0_0", payload: { visitId: "visit_2_0_0", documentationStatus: "SIGNED" } },
    { organizationId: org, eventName: "claim.rejected", aggregateType: "Claim", aggregateId: "claim_7", payload: { claimId: "claim_7", code: "CO-16" } },
  ] });
  await db.analyticsEvent.createMany({ data: [
    { name: "visitCompleted", organizationId: org, userId: "user_clinician_sf", properties: { branchId: "branch_sf" } },
    { name: "claimSubmitted", organizationId: org, userId: "user_biller", properties: { amount: 135 } },
  ] });

  // An AI conversation with a completed run, tool invocations, and a pending proposed action.
  const convo = await db.aiConversation.create({ data: { id: "ai_convo_1", organizationId: org, userId: "user_admin", title: "Billing blockers review" } });
  const aiRun = await db.aiRun.create({ data: {
    id: "ai_run_1", organizationId: org, conversationId: convo.id, requestedBy: "user_admin",
    purpose: "billing-blockers", prompt: "Find visits that cannot be billed and explain why.",
    response: "Several completed visits are missing signed documentation.", model: "fake-operations-1",
    inputTokens: 1800, outputTokens: 120, status: "COMPLETED", completedAt: date(-1),
  } });
  await db.aiToolInvocation.create({ data: { runId: aiRun.id, toolName: "list_unsigned_visits", arguments: { hoursOld: 4 }, result: { count: 6 }, completedAt: date(-1) } });
  await db.aiProposedAction.create({ data: {
    id: "ai_action_1", runId: aiRun.id, actionType: "ASSIGN_TASK", arguments: { queue: "clinical-supervisors" },
    summary: "Assign documentation follow-up tasks to supervising clinicians", status: "PROPOSED",
  } });

  await db.jobRecord.createMany({ data: [
    { type: "process-events", payload: { organizationId: org }, status: "SUCCEEDED", attempts: 1, completedAt: date(-1) },
    { type: "crm-sync", payload: { organizationId: org }, status: "PENDING", runAt: date(0) },
  ] });
  await db.integrationSyncState.create({ data: { organizationId: org, integration: "CRM", lastSyncAt: date(-1), cursor: "2025-06-14" } });
}

const EV_SERVICE_TYPES = ["SKILLED_NURSING", "PHYSICAL_THERAPY", "OCCUPATIONAL_THERAPY", "HOME_HEALTH_AIDE"];
const EV_FIRST = ["Sam", "Robin", "Casey", "Drew", "Quinn", "Reese", "Sky", "Blake", "Jamie", "Kai"];

/**
 * Evergreen Behavioral — the strategically important enterprise customer that
 * is onboarding. It carries the platform's volume and multi-region structure
 * and follows the same legacy VisitSet -> VisitGroup -> Visit distribution:
 * ~97% of sets have one group, ~94% of groups have one visit, with a handful
 * of genuine multi-group / multi-visit historical records.
 */
async function seedEvergreen(): Promise<void> {
  const org = await db.organization.create({ data: { id: "org_evergreen", slug: "evergreen-behavioral", name: "Evergreen Behavioral Health", enterprise: true } });

  const regions = await Promise.all([
    db.region.create({ data: { id: "ev_region_north", organizationId: org.id, name: "Northern" } }),
    db.region.create({ data: { id: "ev_region_south", organizationId: org.id, name: "Southern" } }),
  ]);
  const branchDefs = [
    { id: "ev_branch_portland", regionId: regions[0].id, name: "Portland", city: "Portland", state: "OR" },
    { id: "ev_branch_seattle", regionId: regions[0].id, name: "Seattle", city: "Seattle", state: "WA" },
    { id: "ev_branch_denver", regionId: regions[1].id, name: "Denver", city: "Denver", state: "CO" },
    { id: "ev_branch_phoenix", regionId: regions[1].id, name: "Phoenix", city: "Phoenix", state: "AZ" },
  ];
  await db.branch.createMany({ data: branchDefs.map((branch) => ({ id: branch.id, organizationId: org.id, regionId: branch.regionId, name: branch.name })) });
  await db.location.createMany({ data: branchDefs.map((branch) => ({ id: `${branch.id}_loc`, organizationId: org.id, branchId: branch.id, name: `${branch.name} Facility`, city: branch.city, state: branch.state })) });
  await db.team.createMany({ data: branchDefs.map((branch) => ({ id: `${branch.id}_team`, branchId: branch.id, organizationId: org.id, name: `${branch.name} Clinical` })) });

  await db.user.createMany({ data: [
    { id: "ev_user_admin", organizationId: org.id, email: "admin@evergreen.example", displayName: "Erin Enterprise", role: UserRole.ADMIN },
    { id: "ev_user_biller", organizationId: org.id, email: "billing@evergreen.example", displayName: "Bell Billing", role: UserRole.BILLER },
    { id: "ev_user_north_lead", organizationId: org.id, email: "north@evergreen.example", displayName: "Nora North", role: UserRole.ADMIN, title: "Region Director" },
    { id: "ev_user_viewer", organizationId: org.id, email: "audit@evergreen.example", displayName: "Val Viewer", role: UserRole.VIEWER },
  ] });
  const evClinicians = branchDefs.map((branch, index) => ({
    id: `ev_clin_${index}`, organizationId: org.id, email: `clin${index}@evergreen.example`,
    displayName: `${EV_FIRST[index]!} Clinician`, role: UserRole.CLINICIAN, credential: index % 2 === 0 ? "RN" : "PT",
  }));
  await db.user.createMany({ data: evClinicians });
  await db.userBranch.createMany({ data: [
    ...evClinicians.map((clin, index) => ({ userId: clin.id, branchId: branchDefs[index]!.id })),
    { userId: "ev_user_north_lead", branchId: "ev_branch_portland" },
    { userId: "ev_user_north_lead", branchId: "ev_branch_seattle" },
    { userId: "ev_user_viewer", branchId: "ev_branch_denver" },
  ] });
  await db.clinicianProfile.createMany({ data: evClinicians.map((clin, index) => ({
    userId: clin.id, credential: index % 2 === 0 ? "RN" : "PT", discipline: index % 2 === 0 ? "Skilled Nursing" : "Physical Therapy", npi: `200000000${index}`,
  })) });

  const contract = await db.payerContract.create({ data: {
    id: "ev_contract_blue", payerId: "payer_blue", organizationId: org.id, name: "Blue Shield Enterprise 2025",
    effectiveFrom: new Date("2025-01-01T00:00:00Z"), precedence: 5,
  } });
  await db.payerRate.createMany({ data: [
    { id: "ev_rate_sn", contractId: contract.id, serviceType: "SKILLED_NURSING", amount: new Prisma.Decimal("158.00"), effectiveFrom: new Date("2025-01-01T00:00:00Z") },
    { id: "ev_rate_pt", contractId: contract.id, serviceType: "PHYSICAL_THERAPY", amount: new Prisma.Decimal("140.00"), effectiveFrom: new Date("2025-01-01T00:00:00Z") },
    { id: "ev_rate_ot", contractId: contract.id, serviceType: "OCCUPATIONAL_THERAPY", amount: new Prisma.Decimal("138.00"), effectiveFrom: new Date("2025-01-01T00:00:00Z") },
    { id: "ev_rate_hha", contractId: contract.id, serviceType: "HOME_HEALTH_AIDE", amount: new Prisma.Decimal("42.00"), unit: "HOUR", effectiveFrom: new Date("2025-01-01T00:00:00Z") },
  ] });

  const PATIENT_COUNT = 48;
  const patients: Prisma.PatientCreateManyInput[] = [];
  const coverages: Prisma.InsuranceCoverageCreateManyInput[] = [];
  const episodes: Prisma.CareEpisodeCreateManyInput[] = [];
  const orders: Prisma.ServiceOrderCreateManyInput[] = [];
  const auths: Prisma.AuthorizationCreateManyInput[] = [];
  const sets: Prisma.VisitSetCreateManyInput[] = [];
  const groups: Prisma.VisitGroupCreateManyInput[] = [];
  const visits: Prisma.VisitCreateManyInput[] = [];
  const notes: Prisma.ClinicalNoteCreateManyInput[] = [];

  for (let p = 0; p < PATIENT_COUNT; p += 1) {
    const pid = `patient_ev_${p.toString().padStart(3, "0")}`;
    const cid = `coverage_ev_${p.toString().padStart(3, "0")}`;
    const serviceType = EV_SERVICE_TYPES[p % EV_SERVICE_TYPES.length]!;
    const branch = branchDefs[p % branchDefs.length]!;
    const clinician = evClinicians[p % evClinicians.length]!;
    patients.push({ id: pid, organizationId: org.id, externalId: `EV-${2000 + p}`, mrn: `EVMRN${3000 + p}`,
      firstName: EV_FIRST[p % EV_FIRST.length]!, lastName: `Rivera${p.toString().padStart(2, "0")}`,
      dateOfBirth: new Date(Date.UTC(1945 + (p % 45), p % 12, 1 + (p % 26))), currentCoverageId: cid, phone: `503-555-${(2000 + p).toString()}` });
    coverages.push({ id: cid, patientId: pid, payerId: "payer_blue", memberId: `BSR${400000 + p}`, planName: "Blue Enterprise PPO",
      effectiveFrom: new Date("2025-01-01T00:00:00Z"), verifiedAt: date(-100), coinsurancePercent: 20, copayAmount: new Prisma.Decimal("25.00") });
    episodes.push({ id: `ev_ep_${p}`, patientId: pid, name: "Enterprise episode", startedAt: date(-120 + p) });
    orders.push({ id: `ev_order_${p}`, episodeId: `ev_ep_${p}`, serviceType, orderedBy: "Dr. Enterprise", orderedAt: date(-115 + p) });
    auths.push({ id: `ev_auth_${p}`, coverageId: cid, authorizationNumber: `EVAUTH-${6000 + p}`, serviceType,
      maxVisits: 20, effectiveFrom: date(-110), effectiveTo: date(120), payerReference: `BSR-AUTH-${p}` });
    // Abandoned intake: a couple of empty sets with a placeholder group and no visits.
    const abandoned = p === 11 || p === 29;
    sets.push({ id: `ev_set_${p}`, organizationId: org.id, patientId: pid, orderId: `ev_order_${p}`, coverageId: cid,
      authorizationId: `ev_auth_${p}`, serviceType, expectedVisitCount: 20, startDate: date(-100 + p),
      status: abandoned ? "ABANDONED" : "ACTIVE", billingStatus: p % 3 === 0 ? "READY" : "NOT_READY" });

    // ~97% of sets have a single group; sets 5 and 23 get a second group.
    const groupCount = abandoned ? 1 : p === 5 || p === 23 ? 2 : 1;
    for (let g = 0; g < groupCount; g += 1) {
      const gid = `ev_group_${p}_${g}`;
      // ~94% of groups have a single visit; a couple get two.
      const multiVisit = !abandoned && (p === 5 || p === 17) && g === 0;
      groups.push({ id: gid, visitSetId: `ev_set_${p}`, branchId: branch.id, primaryClinicianId: clinician.id,
        scheduledDate: date(-60 + p + g), serviceType: p % 8 === 0 ? serviceType : null,
        status: abandoned ? "PLACEHOLDER" : "COMPLETED",
        documentationStatus: p % 5 === 0 ? "MISSING" : "SIGNED", billingStatus: p % 3 === 0 ? "READY" : "NOT_READY", sequenceNumber: g + 1 });
      if (abandoned) continue;
      const visitsInGroup = multiVisit ? 2 : 1;
      for (let v = 0; v < visitsInGroup; v += 1) {
        const vid = `ev_visit_${p}_${g}_${v}`;
        const scheduled = date(-60 + p + g, 9 + v);
        // Mix of statuses: mostly completed, some scheduled/cancelled/no-show.
        const status = p % 13 === 0 && g === 0 && v === 0 ? VisitStatus.CANCELLED
          : p % 11 === 0 ? VisitStatus.SCHEDULED
          : p % 17 === 0 ? VisitStatus.NO_SHOW
          : VisitStatus.COMPLETED;
        const completed = status === VisitStatus.COMPLETED;
        visits.push({ id: vid, visitGroupId: gid, patientId: pid, clinicianId: clinician.id,
          locationId: `${branch.id}_loc`, serviceType: p % 8 === 0 ? serviceType : null,
          scheduledStart: scheduled, scheduledEnd: new Date(scheduled.getTime() + 60 * 60 * 1000),
          actualStart: completed ? scheduled : null, actualEnd: completed ? new Date(scheduled.getTime() + (45 + (p % 20)) * 60 * 1000) : null,
          status, completedAt: completed ? new Date(scheduled.getTime() + 70 * 60 * 1000) : null,
          cancelledAt: status === VisitStatus.CANCELLED ? scheduled : null,
          cancellationReason: status === VisitStatus.CANCELLED ? "Patient rescheduled" : null });
        if (completed && p % 5 !== 0) {
          notes.push({ id: `ev_note_${p}_${g}_${v}`, visitId: vid, authorId: clinician.id,
            content: { subjective: "Stable", objective: "Tolerated treatment", plan: "Continue" },
            status: p % 4 === 0 ? "DRAFT" : "SIGNED",
            signedAt: p % 4 === 0 ? null : new Date(scheduled.getTime() + 2 * 3_600_000), signedBy: p % 4 === 0 ? null : clinician.id });
        }
      }
    }
  }

  // A near-duplicate of the first enterprise patient plus a pending match,
  // for the merge workflow demo. Same name + DOB + phone as patient_ev_000,
  // entered twice with no uniqueness constraint to stop it.
  const ev0 = patients[0]!;
  patients.push({ id: "patient_ev_dupe", organizationId: org.id, mrn: "EVMRN-DUP", firstName: ev0.firstName, lastName: ev0.lastName,
    dateOfBirth: ev0.dateOfBirth, phone: ev0.phone, currentCoverageId: null });

  await db.patient.createMany({ data: patients });
  await db.patientProfile.createMany({ data: patients.map((patient) => ({ patientId: patient.id!, legalName: `${patient.firstName} ${patient.lastName}`, phone: patient.phone })) });
  await db.possiblePatientMatch.create({ data: { patientId: "patient_ev_dupe", candidateId: "patient_ev_000", score: 0.96 } });
  await db.insuranceCoverage.createMany({ data: coverages });
  await db.careEpisode.createMany({ data: episodes });
  await db.serviceOrder.createMany({ data: orders });
  await db.orderDetails.createMany({ data: orders.map((order) => ({ orderId: order.id!, diagnosis: "Enterprise dx", frequency: "3x weekly", durationWeeks: 9 })) });
  await db.serviceRequest.createMany({ data: orders.map((order) => ({ orderId: order.id!, requestedUnits: 20, requestedStart: date(-100) })) });
  await db.authorization.createMany({ data: auths });
  await db.visitSet.createMany({ data: sets });
  await db.visitGroup.createMany({ data: groups });
  await db.visit.createMany({ data: visits });
  await db.clinicalNote.createMany({ data: notes });

  // Charges + claims for a slice of completed evergreen visits.
  const completedVisits = visits.filter((visit) => visit.status === VisitStatus.COMPLETED).slice(0, 30);
  const charges: Prisma.ChargeCreateManyInput[] = [];
  const chargeLines: Prisma.ChargeLineCreateManyInput[] = [];
  const claims: Prisma.ClaimCreateManyInput[] = [];
  const claimLines: Prisma.ClaimLineCreateManyInput[] = [];
  const attempts: Prisma.ClaimSubmissionAttemptCreateManyInput[] = [];
  const rejections: Prisma.ClaimRejectionCreateManyInput[] = [];
  const payments: Prisma.PaymentCreateManyInput[] = [];
  const applications: Prisma.CashApplicationCreateManyInput[] = [];

  completedVisits.forEach((visit, index) => {
    const amount = new Prisma.Decimal(index % 3 === 0 ? "140.00" : "158.00");
    const chargeId = `ev_charge_${index}`;
    const lineId = `ev_charge_line_${index}`;
    charges.push({ id: chargeId, visitId: visit.id!, coverageId: null, status: "POSTED", totalAmount: amount, postedAt: date(-30 + index) });
    chargeLines.push({ id: lineId, chargeId, serviceCode: index % 3 === 0 ? "PHYSICAL_THERAPY" : "SKILLED_NURSING", units: new Prisma.Decimal(1), unitPrice: amount, amount });

    const status = index % 6 === 0 ? "REJECTED" : index % 5 === 0 ? "PAID" : index % 3 === 0 ? "ACCEPTED" : "SUBMITTED";
    const balance = status === "PAID" ? new Prisma.Decimal(0) : amount;
    const claimId = `ev_claim_${index}`;
    claims.push({ id: claimId, organizationId: org.id, patientId: visit.patientId!, payerId: "payer_blue",
      branchId: null, status: status as never, externalId: status === "REJECTED" ? null : `BSR-${8000 + index}`,
      claimNumber: `EVCLM-${8000 + index}`, totalAmount: amount, balanceAmount: balance, submittedAt: date(-25 + index), createdAt: date(-26 + index) });
    claimLines.push({ id: `ev_claim_line_${index}`, claimId, chargeLineId: lineId, serviceCode: index % 3 === 0 ? "PHYSICAL_THERAPY" : "SKILLED_NURSING", units: new Prisma.Decimal(1), amount });
    attempts.push({ claimId, status, requestId: `EVREQ-${index}`, response: { externalId: `BSR-${8000 + index}` }, attemptedAt: date(-25 + index) });
    if (status === "REJECTED") {
      rejections.push({ claimId, code: index % 12 === 0 ? "CO-97" : "CO-16", message: index % 12 === 0 ? "Service bundled" : "Missing information", category: index % 12 === 0 ? "BUNDLING" : "MISSING_INFO" });
    }
    if (status === "PAID") {
      const paymentId = `ev_payment_${index}`;
      payments.push({ id: paymentId, organizationId: org.id, externalId: `EV-ERA-${9000 + index}`, payerId: "payer_blue", amount, unappliedAmount: new Prisma.Decimal(0), receivedAt: date(-10 + index), status: "POSTED" });
      applications.push({ paymentId, claimId, amount, appliedAt: date(-10 + index) });
    }
  });

  await db.charge.createMany({ data: charges });
  await db.chargeLine.createMany({ data: chargeLines });
  await db.claim.createMany({ data: claims });
  await db.claimLine.createMany({ data: claimLines });
  await db.claimSubmissionAttempt.createMany({ data: attempts });
  await db.claimRejection.createMany({ data: rejections });
  await db.payment.createMany({ data: payments });
  // One unapplied payment sitting in the queue.
  await db.payment.create({ data: { organizationId: org.id, externalId: "EV-ERA-UNAPPLIED", payerId: "payer_blue", amount: new Prisma.Decimal("316.00"), unappliedAmount: new Prisma.Decimal("316.00"), receivedAt: date(-3), status: "RECEIVED" } });
  await db.cashApplication.createMany({ data: applications });

  await db.accountingPeriod.createMany({ data: [
    { id: "ev_period_apr", organizationId: org.id, year: 2025, month: 4, status: "CLOSED", closedAt: date(-45), closedBy: "ev_user_biller" },
    { id: "ev_period_may", organizationId: org.id, year: 2025, month: 5, status: "CLOSED", closedAt: date(-15), closedBy: "ev_user_biller" },
    { id: "ev_period_jun", organizationId: org.id, year: 2025, month: 6 },
  ] });

  await db.customFieldDefinition.createMany({ data: [
    { id: "ev_field_program", organizationId: org.id, entityType: "Patient", key: "program", label: "Care Program", dataType: "SELECT", configuration: { options: ["IOP", "PHP", "Outpatient"] } },
    { id: "ev_field_priorauth", organizationId: org.id, entityType: "VisitSet", key: "prior_auth_ref", label: "Prior Auth Ref", dataType: "STRING", configuration: {} },
  ] });
  await db.customFieldValue.createMany({ data: [
    { definitionId: "ev_field_program", entityType: "Patient", entityId: "patient_ev_000", stringValue: "IOP" },
    { definitionId: "ev_field_program", entityType: "Patient", entityId: "patient_ev_001", stringValue: "PHP" },
  ] });

  await db.workflowDefinition.createMany({ data: [
    { id: "ev_wf_unsigned", organizationId: org.id, name: "Notify supervisor of unsigned visits", eventName: "visit.completed",
      condition: { and: [{ field: "documentationStatus", op: "equals", value: "MISSING" }] },
      actions: [{ type: "notify_supervisor", message: "Unsigned completed visit" }], enabled: true, createdBy: "ev_user_admin" },
    { id: "ev_wf_rejection", organizationId: org.id, name: "Task on claim rejection", eventName: "claim.rejected",
      condition: {}, actions: [{ type: "create_task", title: "Rework rejected claim", assigneeId: "ev_user_biller" }], enabled: true, createdBy: "ev_user_admin" },
    { id: "ev_wf_large_payment", organizationId: org.id, name: "Finance review for large payment", eventName: "payment.posted",
      condition: { field: "amount", op: "greater_than", value: 1000 }, actions: [{ type: "require_review", threshold: 1000 }], enabled: false, createdBy: "ev_user_admin" },
  ] });

  const evEndpoint = await db.webhookEndpoint.create({ data: { id: "ev_wh", organizationId: org.id, url: "http://localhost:3000/simulators/webhook", secret: "whsec_evseeded02", eventNames: ["branch.assignment.changed"], createdBy: "ev_user_admin" } });
  await db.webhookDelivery.create({ data: { endpointId: evEndpoint.id, eventName: "branch.assignment.changed", payload: { patientId: "patient_ev_000" }, status: "DELIVERED", attempts: 1, responseStatus: 200, lastAttemptAt: date(-2) } });

  await db.reportDefinition.create({ data: { id: "ev_rpt_program", organizationId: org.id, key: "census_by_program", name: "Census by Program", baseView: "PATIENTS", shared: true, createdBy: "ev_user_admin",
    columns: [{ key: "displayName" }, { key: "program" }], groupings: ["program"], calculations: [{ key: "count", formula: "count", column: "id" }] } });
  await db.scheduledExport.create({ data: { id: "ev_sched_census", organizationId: org.id, name: "Nightly census export", reportKey: "census_by_program", cron: "0 2 * * *", format: "CSV", destinationUrl: "http://localhost:3000/simulators/webhook", createdBy: "ev_user_admin", nextRunAt: date(0) } });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => db.$disconnect());
