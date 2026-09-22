// Stubbed integrations with the outside world. In production these talk to the
// SMTP relay, the customer-portal upload service, and the clearinghouse API.

export interface EmailDeliveryDependencies {
  attachDocument(method: string, reference: string, pdf: Buffer): void;
  deliver(to: string, invoiceNumber: string): void;
}

const defaultEmailDeliveryDependencies: EmailDeliveryDependencies = {
  attachDocument,
  deliver(to, invoiceNumber) {
    console.log(`[email] sending invoice ${invoiceNumber} to ${to}`);
  },
};

export function sendEmail(
  to: string,
  invoiceNumber: string,
  pdf: Buffer,
  dependencies: EmailDeliveryDependencies = defaultEmailDeliveryDependencies
): { status: string; detail: string } {
  // Email is a single delivery operation: the document must be accepted by the
  // carrier before the message can be reported as sent.
  dependencies.attachDocument("EMAIL", `email:${invoiceNumber}`, pdf);
  dependencies.deliver(to, invoiceNumber);
  return { status: "SENT", detail: `Emailed to ${to}` };
}

// Kicks off an upload job at the external portal service and returns its job id.
export function createPortalJob(portalAccount: string, invoiceNumber: string): {
  externalJobId: string;
  status: string;
  detail: string;
} {
  const externalJobId = `pj_${Math.random().toString(36).slice(2, 10)}`;
  console.log(`[portal] queued upload of ${invoiceNumber} to account ${portalAccount} (${externalJobId})`);
  return { externalJobId, status: "QUEUED", detail: `Upload queued for portal account ${portalAccount}` };
}

// Polls the external portal service for job status. The stub advances by elapsed time.
export function checkPortalJob(createdAt: Date): string {
  const elapsedMs = Date.now() - createdAt.getTime();
  if (elapsedMs < 10_000) return "QUEUED";
  if (elapsedMs < 30_000) return "UPLOADING";
  return "DELIVERED";
}

// Hands the rendered invoice document to the carrier for a transmission.
export function attachDocument(method: string, reference: string, pdf: Buffer): void {
  console.log(`[pdf] ${pdf.length} byte document attached to ${method} transmission ${reference}`);
}

// Submits the invoice to the clearinghouse's standardized API.
export function submitToClearinghouse(clearinghouseId: string, invoiceNumber: string): {
  externalJobId: string;
  status: string;
  detail: string;
} {
  const externalJobId = `ch_${Math.random().toString(36).slice(2, 10)}`;
  console.log(`[clearinghouse] submitted ${invoiceNumber} for trading partner ${clearinghouseId}`);
  return { externalJobId, status: "ACCEPTED", detail: `Accepted by clearinghouse (${clearinghouseId})` };
}
