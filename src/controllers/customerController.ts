import { prisma } from "../db";
import { CustomerModel, toCustomerModel } from "../models/customer";
import {
  CustomerPageSchema,
  fingerprintTenantPaginationBinding,
  formatPaginationCursor,
  parsePaginationCursor,
  type CustomerPage,
  type ListCustomersV1Request,
  type PaginationCursorFailureCode,
} from "@meridian/contracts";
import { z } from "zod";

/** Lists only customers owned by the server-derived tenant principal. */
export async function listCustomers(tenantId: string): Promise<CustomerModel[]> {
  const rows = await prisma.customer.findMany({
    where: { tenantId },
    orderBy: { name: "asc" },
  });
  return rows.map(toCustomerModel);
}

const CustomerCursorOrderingSchema = z.tuple([
  z.string().min(1).max(1_024),
  z.string().min(1).max(1_024),
]);

export type CustomerPageResult =
  | { readonly ok: true; readonly page: CustomerPage }
  | { readonly ok: false; readonly code: PaginationCursorFailureCode };

/**
 * Lists a v1 tenant-scoped customer page in ascending `(name, id)` order.
 * `id` is an explicit tie-breaker so a cursor never skips or repeats customers
 * when names collide or another writer inserts between requests.
 */
export async function listCustomersPage(
  tenantId: string,
  query: ListCustomersV1Request["query"]
): Promise<CustomerPageResult> {
  // The opaque SHA-256 fingerprint binds the cursor to server-derived tenant
  // identity without placing that identity in the cursor payload.
  const filterFingerprint = fingerprintTenantPaginationBinding({}, tenantId);
  const parsedCursor = query.cursor === undefined
    ? undefined
    : parsePaginationCursor(query.cursor, { resource: "customers", filterFingerprint });
  if (parsedCursor !== undefined && !parsedCursor.ok) return parsedCursor;

  const ordering = parsedCursor === undefined
    ? undefined
    : CustomerCursorOrderingSchema.safeParse(parsedCursor.ordering);
  if (ordering !== undefined && !ordering.success) {
    return { ok: false, code: "CURSOR_MALFORMED" };
  }

  const [name, id] = ordering === undefined ? [] : ordering.data;
  const rows = await prisma.customer.findMany({
    where: {
      tenantId,
      ...(name === undefined || id === undefined
        ? {}
        : {
            OR: [
              { name: { gt: name } },
              { name, id: { gt: id } },
            ],
          }),
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: query.limit + 1,
  });
  const pageRows = rows.slice(0, query.limit);
  const lastRow = pageRows.at(-1);
  const nextCursor = rows.length > query.limit && lastRow !== undefined
    ? formatPaginationCursor({
        resource: "customers",
        filterFingerprint,
        ordering: [lastRow.name, lastRow.id],
      })
    : null;
  return {
    ok: true,
    page: CustomerPageSchema.parse({
      data: pageRows.map(toCustomerModel),
      page: { limit: query.limit, nextCursor },
    }),
  };
}
