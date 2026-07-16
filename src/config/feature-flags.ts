import { db } from "../lib/db.js";

interface CachedFlags {
  loadedAt: number;
  flags: Map<string, { enabledGlobally: boolean; organizationIds: string[] }>;
}

const CACHE_TTL_MS = 30_000;
let cache: CachedFlags | null = null;

async function loadFlags(): Promise<CachedFlags> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache;
  const rows = await db.featureFlag.findMany();
  const flags = new Map<string, { enabledGlobally: boolean; organizationIds: string[] }>();
  for (const row of rows) {
    flags.set(row.key, {
      enabledGlobally: row.enabledGlobally,
      organizationIds: Array.isArray(row.organizationIds) ? (row.organizationIds as string[]) : [],
    });
  }
  cache = { loadedAt: Date.now(), flags };
  return cache;
}

export async function isFlagEnabled(key: string, organizationId?: string): Promise<boolean> {
  const { flags } = await loadFlags();
  const flag = flags.get(key);
  if (!flag) return false;
  if (flag.enabledGlobally) return true;
  return organizationId ? flag.organizationIds.includes(organizationId) : false;
}

export function invalidateFlagCache(): void {
  cache = null;
}
