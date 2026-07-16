import type { FastifyInstance } from "fastify";
import { contextFor } from "../request-context.js";
import { patientDirectory } from "../../patients/patient-directory.js";
import { patientHeader } from "../../patients/patient-header.js";
import { mergePatients } from "../../patients/merge-service.js";
import { patientHeaderCounts } from "../../reporting/operations-report.js";

export async function registerPatientRoutes(app: FastifyInstance): Promise<void> {
  app.get("/patients", async (request) => {
    const query = request.query as { search?: string; branchId?: string; activeOnly?: string; page?: string; pageSize?: string };
    return patientDirectory(await contextFor(request), {
      search: query.search,
      branchId: query.branchId,
      activeOnly: query.activeOnly === "false" ? false : true,
      page: Number(query.page ?? 1),
      pageSize: Number(query.pageSize ?? 25),
    });
  });

  app.get("/patients/:id", async (request) => patientHeader((request.params as { id: string }).id));
  app.get("/patients/:id/counts", async (request) => patientHeaderCounts((request.params as { id: string }).id));

  app.post("/patients/merge", async (request) => {
    const input = request.body as { survivorId: string; mergedId: string };
    return mergePatients(await contextFor(request), input.survivorId, input.mergedId);
  });
}
