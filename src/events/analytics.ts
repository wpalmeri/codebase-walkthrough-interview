import { db } from "../lib/db.js";
import { asJson } from "../lib/json.js";
import { moduleLogger } from "../lib/logger.js";

/**
 * Product analytics. Fire-and-forget; failures are swallowed. Event names
 * here follow the analytics vendor's camelCase convention rather than the
 * domain event names.
 */

const log = moduleLogger("analytics");

export function track(name: string, properties: Record<string, unknown>, context?: { organizationId?: string; userId?: string }): void {
  void db.analyticsEvent
    .create({
      data: {
        name,
        organizationId: context?.organizationId,
        userId: context?.userId,
        properties: asJson(properties),
      },
    })
    .catch((error) => log.debug({ name, error: String(error) }, "analytics write failed"));
}
