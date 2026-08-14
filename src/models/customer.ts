import type { Customer } from "@prisma/client";

export interface CustomerModel {
  id: string;
  name: string;
  email: string;
  billingAddress: string | null;
  portalAccount: string | null;
  clearinghouseId: string | null;
}

export function toCustomerModel(row: Customer): CustomerModel {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    billingAddress: row.billingAddress,
    portalAccount: row.portalAccount,
    clearinghouseId: row.clearinghouseId,
  };
}
