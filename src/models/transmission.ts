import type { Transmission } from "@prisma/client";
import {
  TransmissionSchema,
  type Transmission as ContractTransmission,
} from "@meridian/contracts";

export type TransmissionModel = ContractTransmission;

export function toTransmissionModel(row: Transmission): TransmissionModel {
  return TransmissionSchema.parse({
    id: row.id,
    invoiceId: row.invoiceId,
    method: row.method,
    status: row.status,
    externalJobId: row.externalJobId,
    detail: row.detail,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}
