import type { Customer } from "@prisma/client";
import { CustomerSchema, type Customer as ContractCustomer } from "@meridian/contracts";

export type CustomerModel = ContractCustomer;

export function toCustomerModel(row: Customer): CustomerModel {
  return CustomerSchema.parse({
    id: row.id,
    name: row.name,
    email: row.email,
    billingAddress: row.billingAddress,
    portalAccount: row.portalAccount,
    clearinghouseId: row.clearinghouseId,
  });
}
