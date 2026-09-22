import { prisma } from "../db";
import { CustomerModel, toCustomerModel } from "../models/customer";

/** Lists only customers owned by the server-derived tenant principal. */
export async function listCustomers(tenantId: string): Promise<CustomerModel[]> {
  const rows = await prisma.customer.findMany({
    where: { tenantId },
    orderBy: { name: "asc" },
  });
  return rows.map(toCustomerModel);
}
