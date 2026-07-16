export interface CoverageDomainModel {
  id: string;
  patientId: string;
  payerId: string;
  payerName: string;
  planName: string;
  memberId: string;
  priority: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  verified: boolean;
  copayCents: number | null;
  coinsurancePercent: number | null;
}

export function coverageActiveOn(coverage: CoverageDomainModel, date: Date): boolean {
  if (coverage.effectiveFrom > date) return false;
  if (coverage.effectiveTo && coverage.effectiveTo < date) return false;
  return true;
}

export function primaryCoverage(coverages: CoverageDomainModel[], asOf: Date): CoverageDomainModel | null {
  const active = coverages.filter((coverage) => coverageActiveOn(coverage, asOf));
  active.sort((a, b) => a.priority - b.priority);
  return active[0] ?? null;
}
