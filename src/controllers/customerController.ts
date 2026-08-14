import { prisma } from "../db";
import { CustomerModel, toCustomerModel } from "../models/customer";

export async function listCustomers(): Promise<CustomerModel[]> {
  const rows = await prisma.customer.findMany({ orderBy: { name: "asc" } });
  return rows.map(toCustomerModel);
}
