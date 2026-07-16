import { NotFoundError } from "../lib/errors.js";
import { LegacyVisitRepository } from "../legacy/visit-repository.js";
import { legacyAggregateToDomain } from "../legacy/visit-mapper.js";
import { domainToVisitResponse } from "./api-dto.js";

const repository = new LegacyVisitRepository();

export async function getVisitResponse(visitId: string) {
  const record = await repository.findOne(visitId);
  if (!record) throw new NotFoundError("Visit not found");
  return domainToVisitResponse(legacyAggregateToDomain(record));
}
