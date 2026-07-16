// Credential-based rate modifiers. Contracts encode assistant rates as a
// discount off the primary credential. Only visit completion and the pricing
// service apply these; estimates and reports price everything at 100%.

export const CREDENTIAL_MODIFIERS: Record<string, number> = {
  RN: 1.0,
  LVN: 0.85,
  PT: 1.0,
  PTA: 0.85,
  OT: 1.0,
  COTA: 0.85,
  MSW: 1.0,
  HHA: 1.0,
};

export function credentialMultiplier(credential: string | null | undefined): number {
  if (!credential) return 1.0;
  return CREDENTIAL_MODIFIERS[credential] ?? 1.0;
}
