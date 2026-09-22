import {
  MONEY_PRECISION,
  MONEY_SCALE,
  QUANTITY_PRECISION,
  QUANTITY_SCALE,
  decimalOrLegacy,
  type DecimalInput,
} from "../domain/money";

export interface PdfInvoiceLine {
  description: string;
  quantity: number;
  quantityDecimal?: DecimalInput | null;
  unitPrice: number;
  unitPriceDecimal?: DecimalInput | null;
  amount: number;
  amountDecimal?: DecimalInput | null;
}

export interface PdfInvoice {
  number: string;
  customerName: string;
  billingAddress?: string | null;
  issueDate: Date;
  dueDate: Date;
  total: number;
  totalDecimal?: DecimalInput | null;
  lines: PdfInvoiceLine[];
}

const moneyFormat = { scale: MONEY_SCALE, precision: MONEY_PRECISION, field: "amount" } as const;
const quantityFormat = {
  scale: QUANTITY_SCALE,
  precision: QUANTITY_PRECISION,
  field: "quantity",
} as const;
const ROWS_PER_PAGE = 38;

function printable(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)")
    .replace(/[\r\n\t]/gu, " ")
    .replace(/[^\x20-\x7E]/gu, "?");
}

function exactMoney(decimal: DecimalInput | null | undefined, legacy: number, field: string): string {
  return decimalOrLegacy(
    { decimal, legacy },
    { ...moneyFormat, field }
  );
}

function exactQuantity(line: PdfInvoiceLine): string {
  const canonical = decimalOrLegacy(
    { decimal: line.quantityDecimal, legacy: line.quantity },
    { ...quantityFormat, field: "invoice line quantity" }
  );
  const [whole, fraction = ""] = canonical.split(".");
  const trimmedFraction = fraction.replace(/0+$/u, "");
  return trimmedFraction.length === 0 ? whole : `${whole}.${trimmedFraction}`;
}

function padded(value: string, width: number, alignment: "left" | "right" = "left"): string {
  const clipped = value.slice(0, width);
  return alignment === "left" ? clipped.padEnd(width) : clipped.padStart(width);
}

function statementLines(invoice: PdfInvoice): string[] {
  const header = [
    `INVOICE ${invoice.number}`,
    `BILL TO ${invoice.customerName}`,
    ...(invoice.billingAddress ? [`         ${invoice.billingAddress}`] : []),
    `ISSUED ${invoice.issueDate.toISOString().slice(0, 10)}   DUE ${invoice.dueDate.toISOString().slice(0, 10)}`,
    "-".repeat(88),
    `${padded("DESCRIPTION", 48)} ${padded("QTY", 8, "right")} ${padded("UNIT", 13, "right")} ${padded("AMOUNT", 14, "right")}`,
  ];
  const rows = invoice.lines.map((line) => {
    const unitPrice = exactMoney(line.unitPriceDecimal, line.unitPrice, "invoice line unit price");
    const amount = exactMoney(line.amountDecimal, line.amount, "invoice line amount");
    return `${padded(line.description, 48)} ${padded(exactQuantity(line), 8, "right")} ${padded(unitPrice, 13, "right")} ${padded(amount, 14, "right")}`;
  });
  const total = exactMoney(invoice.totalDecimal, invoice.total, "invoice total");
  return [...header, ...rows, "-".repeat(88), `${padded("TOTAL DUE", 72)} ${padded(total, 14, "right")}`];
}

function contentStream(lines: readonly string[]): string {
  const commands = ["BT", "/F1 9 Tf", "42 756 Td", "11 TL"];
  lines.forEach((line, index) => {
    if (index > 0) commands.push("T*");
    commands.push(`(${printable(line)}) Tj`);
  });
  commands.push("ET");
  return `${commands.join("\n")}\n`;
}

function pdfObject(id: number, body: string): string {
  return `${id} 0 obj\n${body}\nendobj\n`;
}

/**
 * Produces a deterministic, structurally valid, multi-page PDF without a fixed
 * render buffer. Exact Decimal fields win over legacy floats at the document
 * boundary, matching the API and persistence rollout behavior.
 */
export function renderInvoicePdf(invoice: PdfInvoice): Buffer {
  const lines = statementLines(invoice);
  const pages: string[][] = [];
  for (let offset = 0; offset < lines.length; offset += ROWS_PER_PAGE) {
    pages.push(lines.slice(offset, offset + ROWS_PER_PAGE));
  }
  if (pages.length === 0) pages.push([]);

  const catalogId = 1;
  const pagesId = 2;
  const fontId = 3;
  const pageIds = pages.map((_, index) => 4 + index * 2);
  const objects = new Map<number, string>();
  objects.set(catalogId, pdfObject(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`));
  objects.set(
    pagesId,
    pdfObject(
      pagesId,
      `<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`
    )
  );
  objects.set(fontId, pdfObject(fontId, "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>"));

  pages.forEach((pageLines, index) => {
    const pageId = pageIds[index];
    if (pageId === undefined) throw new Error("PDF page id is missing");
    const contentId = pageId + 1;
    const stream = contentStream(pageLines);
    objects.set(
      pageId,
      pdfObject(
        pageId,
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`
      )
    );
    objects.set(
      contentId,
      pdfObject(contentId, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`)
    );
  });

  const objectCount = 3 + pages.length * 2;
  const header = "%PDF-1.4\n%MERIDIAN\n";
  let body = header;
  const offsets = [0];
  for (let id = 1; id <= objectCount; id += 1) {
    const object = objects.get(id);
    if (!object) throw new Error(`PDF object ${id} is missing`);
    offsets[id] = Buffer.byteLength(body);
    body += object;
  }
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objectCount + 1}\n`;
  body += "0000000000 65535 f \n";
  for (let id = 1; id <= objectCount; id += 1) {
    body += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objectCount + 1} /Root ${catalogId} 0 R >>\n`;
  body += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "ascii");
}
