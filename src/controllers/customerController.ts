import { prisma } from "../db";
import { CustomerModel, toCustomerModel } from "../models/customer";
import {
  CustomerPageSchema,
  fingerprintPaginationFilters,
  formatPaginationCursor,
  parsePaginationCursor,
  type CustomerPage,
  type ListCustomersV1Request,
  type PaginationCursorFailureCode,
} from "@meridian/contracts";
import { z } from "zod";

/** Lists every bill-to customer in the company-owned billing system. */
export async function listCustomers(): Promise<CustomerModel[]> {
  const rows = await prisma.customer.findMany({
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
 * Lists a v1 customer page in ascending `(name, id)` order.
 * `id` is an explicit tie-breaker so a cursor never skips or repeats customers
 * when names collide or another writer inserts between requests.
 */
export async function listCustomersPage(
  query: ListCustomersV1Request["query"]
): Promise<CustomerPageResult> {
  const filterFingerprint = fingerprintPaginationFilters({});
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
    where: name === undefined || id === undefined
      ? {}
      : {
          OR: [
            { name: { gt: name } },
            { name, id: { gt: id } },
          ],
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
