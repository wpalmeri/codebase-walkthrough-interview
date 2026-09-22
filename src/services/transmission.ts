import {
  TransmissionMethodSchema,
  TransmissionStatusSchema,
  type TransmissionMethod,
  type TransmissionStatus,
} from "@meridian/contracts";
import { randomBytes } from "node:crypto";
import { z } from "zod";

// Stubbed integrations with the outside world. In production these talk to the
// SMTP relay, the customer-portal upload service, and the clearinghouse API.

export interface EmailDeliveryDependencies {
  attachDocument(method: TransmissionMethod, reference: string, pdf: Buffer): void;
  deliver(to: string, invoiceNumber: string): void;
  telemetry?: TransmissionTelemetry;
}

export const TransmissionLogEventSchema = z.strictObject({
  level: z.literal("info"),
  event: z.enum(["DOCUMENT_ATTACHED", "DELIVERY_ACCEPTED", "PORTAL_JOB_QUEUED", "CLEARINGHOUSE_ACCEPTED"]),
  method: TransmissionMethodSchema,
  status: TransmissionStatusSchema.optional(),
  artifactBytes: z.number().int().nonnegative().optional(),
  jobId: z.string().regex(/^(?:pj|ch)_[a-f0-9]{12}$/u).optional(),
});
export type TransmissionLogEvent = z.infer<typeof TransmissionLogEventSchema>;
export type TransmissionTelemetry = (event: TransmissionLogEvent) => void;

/** Serializes a fixed operational shape that cannot contain destination PII. */
export function createJsonTransmissionTelemetry(
  write: (line: string) => void = (line) => console.log(line)
): TransmissionTelemetry {
  return (event) => write(JSON.stringify(TransmissionLogEventSchema.parse(event)));
}

const defaultTelemetry = createJsonTransmissionTelemetry();

const defaultEmailDeliveryDependencies: EmailDeliveryDependencies = {
  attachDocument,
  deliver() {},
  telemetry: defaultTelemetry,
};

export function sendEmail(
  to: string,
  invoiceNumber: string,
  pdf: Buffer,
  dependencies: EmailDeliveryDependencies = defaultEmailDeliveryDependencies
): { status: TransmissionStatus; detail: string } {
  // Email is a single delivery operation: the document must be accepted by the
  // carrier before the message can be reported as sent.
  dependencies.attachDocument("EMAIL", `email:${invoiceNumber}`, pdf);
  dependencies.deliver(to, invoiceNumber);
  dependencies.telemetry?.({
    level: "info",
    event: "DELIVERY_ACCEPTED",
    method: "EMAIL",
    status: "SENT",
  });
  return { status: "SENT", detail: `Emailed to ${to}` };
}

// Kicks off an upload job at the external portal service and returns its job id.
export function createPortalJob(
  portalAccount: string,
  invoiceNumber: string,
  telemetry: TransmissionTelemetry = defaultTelemetry
): {
  externalJobId: string;
  status: TransmissionStatus;
  detail: string;
} {
  const externalJobId = `pj_${randomBytes(6).toString("hex")}`;
  telemetry({
    level: "info",
    event: "PORTAL_JOB_QUEUED",
    method: "PORTAL",
    status: "QUEUED",
    jobId: externalJobId,
  });
  return { externalJobId, status: "QUEUED", detail: `Upload queued for portal account ${portalAccount}` };
}

// Polls the external portal service for job status. The stub advances by elapsed time.
export function checkPortalJob(createdAt: Date): TransmissionStatus {
  const elapsedMs = Date.now() - createdAt.getTime();
  if (elapsedMs < 10_000) return "QUEUED";
  if (elapsedMs < 30_000) return "UPLOADING";
  return "DELIVERED";
}

// Hands the rendered invoice document to the carrier for a transmission.
export function attachDocument(
  method: TransmissionMethod,
  _reference: string,
  pdf: Buffer,
  telemetry: TransmissionTelemetry = defaultTelemetry
): void {
  telemetry({
    level: "info",
    event: "DOCUMENT_ATTACHED",
    method,
    artifactBytes: pdf.length,
  });
}

// Submits the invoice to the clearinghouse's standardized API.
export function submitToClearinghouse(
  clearinghouseId: string,
  _invoiceNumber: string,
  telemetry: TransmissionTelemetry = defaultTelemetry
): {
  externalJobId: string;
  status: TransmissionStatus;
  detail: string;
} {
  const externalJobId = `ch_${randomBytes(6).toString("hex")}`;
  telemetry({
    level: "info",
    event: "CLEARINGHOUSE_ACCEPTED",
    method: "API",
    status: "ACCEPTED",
    jobId: externalJobId,
  });
  return { externalJobId, status: "ACCEPTED", detail: `Accepted by clearinghouse (${clearinghouseId})` };
}
