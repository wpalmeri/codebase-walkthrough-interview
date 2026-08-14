import type { Transmission } from "@prisma/client";

export interface TransmissionModel {
  id: string;
  invoiceId: string;
  method: string;
  status: string;
  externalJobId: string | null;
  detail: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toTransmissionModel(row: Transmission): TransmissionModel {
  return {
    id: row.id,
    invoiceId: row.invoiceId,
    method: row.method,
    status: row.status,
    externalJobId: row.externalJobId,
    detail: row.detail,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
