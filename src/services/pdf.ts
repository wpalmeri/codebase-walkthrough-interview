// Renders the invoice PDF that is attached to outbound transmissions. The
// layout is a single-column statement: header, bill-to block, one row per
// invoice line, then totals.

// Invoices can run to thousands of product lines, so the document is rendered
// into a single preallocated buffer to keep the layout pass fast.
const RENDER_BUFFER_SIZE = 64 * 1024;

export interface PdfInvoice {
  number: string;
  customerName: string;
  billingAddress?: string | null;
  issueDate: Date;
  dueDate: Date;
  total: number;
  lines: { description: string; quantity: number; unitPrice: number; amount: number }[];
}

export function renderInvoicePdf(invoice: PdfInvoice): Buffer {
  const buffer = Buffer.alloc(RENDER_BUFFER_SIZE);
  let offset = 0;
  const write = (text: string) => {
    const size = Buffer.byteLength(text);
    if (offset + size > buffer.length) {
      throw new Error(`PDF render buffer exhausted at ${offset} bytes (${invoice.number})`);
    }
    offset += buffer.write(text, offset);
  };

  write("%PDF-1.4\n");
  write(`INVOICE ${invoice.number}\n`);
  write(`BILL TO   ${invoice.customerName}\n`);
  if (invoice.billingAddress) {
    write(`          ${invoice.billingAddress}\n`);
  }
  write(
    `ISSUED ${invoice.issueDate.toISOString().slice(0, 10)}   DUE ${invoice.dueDate
      .toISOString()
      .slice(0, 10)}\n`
  );
  write(`${"".padEnd(88, "-")}\n`);
  write(
    `${"DESCRIPTION".padEnd(48)} ${"QTY".padStart(10)} ${"UNIT".padStart(12)} ${"AMOUNT".padStart(14)}\n`
  );
  for (const line of invoice.lines) {
    write(
      `${line.description.padEnd(48)} ${String(line.quantity).padStart(10)} ${line.unitPrice
        .toFixed(4)
        .padStart(12)} ${line.amount.toFixed(2).padStart(14)}\n`
    );
  }
  write(`${"".padEnd(88, "-")}\n`);
  write(`${"TOTAL DUE".padEnd(72)} ${invoice.total.toFixed(2).padStart(14)}\n`);
  write("%%EOF\n");
  return buffer.subarray(0, offset);
}
