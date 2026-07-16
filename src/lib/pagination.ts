export interface PageRequest {
  page: number;
  pageSize: number;
}

export interface PageResult<T> {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  data: T[];
}

export function normalizePageRequest(query: { page?: string | number; pageSize?: string | number }): PageRequest {
  const page = Math.max(1, Number(query.page ?? 1) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(query.pageSize ?? 25) || 25));
  return { page, pageSize };
}

export function offsetFor(request: PageRequest): number {
  return (request.page - 1) * request.pageSize;
}

/**
 * Standard list envelope. Every paginated endpoint returns an exact total so
 * the UI can render page counts.
 */
export function pageResult<T>(request: PageRequest, total: number, data: T[]): PageResult<T> {
  return {
    page: request.page,
    pageSize: request.pageSize,
    total,
    totalPages: Math.ceil(total / request.pageSize),
    data,
  };
}

export interface KeysetPage<T> {
  data: T[];
  nextCursor: string | null;
}

/**
 * Cursor pagination for large tables. Added for the audit export rewrite;
 * nothing else has migrated to it yet.
 */
export function keysetPage<T extends { id: string }>(rows: T[], limit: number): KeysetPage<T> {
  const data = rows.slice(0, limit);
  return { data, nextCursor: rows.length > limit ? data[data.length - 1]!.id : null };
}
