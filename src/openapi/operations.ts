import { apiOperations } from "../views";

/**
 * The complete version-one API inventory used by publication and contract
 * tests. It is the exact array mounted by Express, so runtime and published
 * paths cannot silently diverge.
 */
export const openApiV1Operations = apiOperations;
