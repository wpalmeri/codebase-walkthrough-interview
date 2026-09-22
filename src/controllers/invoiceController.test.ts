import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  sendInvoiceWithDependencies,
  type InvoiceDeliveryDependencies,
} from "./invoiceController";
import type { InvoiceStatus } from "@meridian/contracts";
import { ConflictError, PreconditionError } from "../errors";
import type { InvoiceModel } from "../models/invoice";

type FailureRecord = Parameters<
  InvoiceDeliveryDependencies["recordFailedTransmission"]
>[0];

const resultInvoice: InvoiceModel = {
  id: "invoice-1",
  number: "INV-00001",
  customerId: "customer-1",
  customerName: "Snapshot Customer",
  customerEmail: "snapshot@example.com",
  billingAddress: "1 Snapshot Way",
  orderId: "order-1",
  orderReference: null,
  status: "SENT",
  issueDate: "2026-01-01T00:00:00.000Z",
  dueDate: "2026-01-31T00:00:00.000Z",
  total: 125,
  amountPaid: 0,
  balance: 125,
  postedAt: "2026-01-01T00:00:00.000Z",
  lines: [],
  payments: [],
  transmissions: [],
  lastTransmission: null,
};

function invoice(status: InvoiceStatus = "POSTED") {
  return {
    id: "invoice-1",
    number: "INV-00001",
    status,
    issueDate: new Date("2026-01-01T00:00:00.000Z"),
    dueDate: new Date("2026-01-31T00:00:00.000Z"),
    total: 125,
    customerNameSnapshot: "Snapshot Customer",
    customerEmailSnapshot: "snapshot@example.com",
    billingAddressSnapshot: "1 Snapshot Way",
    customer: {
      name: "Changed Customer",
      email: "changed@example.com",
      billingAddress: "2 Changed Road",
      portalAccount: "portal-1",
      clearinghouseId: "clearinghouse-1",
    },
    lines: [{ description: "Service", quantity: 1, unitPrice: 125, amount: 125 }],
  };
}

function dependencies(
  overrides: Partial<InvoiceDeliveryDependencies> = {}
): InvoiceDeliveryDependencies {
  return {
    async findInvoice() {
      return invoice();
    },
    renderPdf() {
      return Buffer.from("pdf");
    },
    sendEmail() {
      return { status: "SENT", detail: "sent" };
    },
    createPortalJob() {
      return { status: "QUEUED", detail: "queued", externalJobId: "portal-job-1" };
    },
    submitToClearinghouse() {
      return { status: "ACCEPTED", detail: "accepted", externalJobId: "api-job-1" };
    },
    attachDocument() {},
    async recordSuccessfulTransmission() {},
    async recordFailedTransmission() {},
    async getInvoice() {
      return resultInvoice;
    },
    ...overrides,
  };
}

void describe("invoice delivery", () => {
  void test("renders snapshots before email delivery and records success last", async () => {
    const events: string[] = [];
    const pdf = Buffer.from("rendered pdf");
    const deps = dependencies({
      async findInvoice() {
        events.push("find");
        return invoice();
      },
      renderPdf(input) {
        events.push("render");
        assert.equal(input.customerName, "Snapshot Customer");
        assert.equal(input.billingAddress, "1 Snapshot Way");
        return pdf;
      },
      sendEmail(to, number, deliveredPdf) {
        events.push("deliver");
        assert.equal(to, "snapshot@example.com");
        assert.equal(number, "INV-00001");
        assert.equal(deliveredPdf, pdf);
        return { status: "SENT", detail: "sent" };
      },
      async recordSuccessfulTransmission(input) {
        events.push("record-success");
        assert.deepEqual(input, {
          tenantId: "tenant-1",
          invoiceId: "invoice-1",
          method: "EMAIL",
          status: "SENT",
          detail: "sent",
        });
      },
      async getInvoice() {
        events.push("load-result");
        return resultInvoice;
      },
    });

    await sendInvoiceWithDependencies("tenant-1", "invoice-1", "EMAIL", deps);

    assert.deepEqual(events, ["find", "render", "deliver", "record-success", "load-result"]);
  });

  void test("rejects invoices that are not posted without starting a transmission", async () => {
    let rendered = false;
    let failureRecorded = false;
    const deps = dependencies({
      async findInvoice() {
        return invoice("DRAFT");
      },
      renderPdf() {
        rendered = true;
        return Buffer.from("pdf");
      },
      async recordFailedTransmission() {
        failureRecorded = true;
      },
    });

    await assert.rejects(sendInvoiceWithDependencies("tenant-1", "invoice-1", "EMAIL", deps), (error) => {
      assert.ok(error instanceof ConflictError);
      assert.equal(error.problem.status, 409);
      assert.equal(error.problem.code, "INVOICE_NOT_DELIVERABLE");
      return true;
    });
    assert.equal(rendered, false);
    assert.equal(failureRecorded, false);
  });

  void test("records malformed snapshot email as a failed transmission before rendering", async () => {
    const failures: FailureRecord[] = [];
    let rendered = false;
    const deps = dependencies({
      async findInvoice() {
        return { ...invoice(), customerEmailSnapshot: "not-an-email" };
      },
      renderPdf() {
        rendered = true;
        return Buffer.from("pdf");
      },
      async recordFailedTransmission(input) {
        failures.push(input);
      },
    });

    await assert.rejects(sendInvoiceWithDependencies("tenant-1", "invoice-1", "EMAIL", deps), (error) => {
      assert.ok(error instanceof PreconditionError);
      assert.equal(error.problem.status, 412);
      assert.equal(error.problem.code, "DELIVERY_RECIPIENT_INVALID");
      assert.doesNotMatch(JSON.stringify(error.problem), /not-an-email/);
      return true;
    });

    assert.equal(rendered, false);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.method, "EMAIL");
    assert.match(failures[0]?.detail ?? "", /recipient validation/);
    assert.doesNotMatch(failures[0]?.detail ?? "", /not-an-email/);
  });

  void test("returns a precondition problem when a portal destination is missing", async () => {
    const failures: FailureRecord[] = [];
    let rendered = false;
    const deps = dependencies({
      async findInvoice() {
        return {
          ...invoice(),
          customer: { ...invoice().customer, portalAccount: null },
        };
      },
      renderPdf() {
        rendered = true;
        return Buffer.from("pdf");
      },
      async recordFailedTransmission(input) {
        failures.push(input);
      },
    });

    await assert.rejects(sendInvoiceWithDependencies("tenant-1", "invoice-1", "PORTAL", deps), (error) => {
      assert.ok(error instanceof PreconditionError);
      assert.equal(error.problem.status, 412);
      assert.equal(error.problem.code, "DELIVERY_DESTINATION_MISSING");
      return true;
    });

    assert.equal(rendered, false);
    assert.equal(failures.length, 1);
    assert.match(failures[0]?.detail ?? "", /recipient validation/);
  });

  void test("records render failures and never calls the delivery provider", async () => {
    const failures: FailureRecord[] = [];
    let delivered = false;
    const deps = dependencies({
      renderPdf() {
        throw new Error("render buffer exhausted");
      },
      sendEmail() {
        delivered = true;
        return { status: "SENT", detail: "sent" };
      },
      async recordFailedTransmission(input) {
        failures.push(input);
      },
    });

    await assert.rejects(
      sendInvoiceWithDependencies("tenant-1", "invoice-1", "EMAIL", deps),
      /render buffer exhausted/
    );
    assert.equal(delivered, false);
    assert.match(failures[0]?.detail ?? "", /PDF rendering/);
  });

  void test("records portal attachment failures with the external job id", async () => {
    const failures: FailureRecord[] = [];
    let successRecorded = false;
    const deps = dependencies({
      attachDocument() {
        throw new Error("portal rejected PDF");
      },
      async recordSuccessfulTransmission() {
        successRecorded = true;
      },
      async recordFailedTransmission(input) {
        failures.push(input);
      },
    });

    await assert.rejects(
      sendInvoiceWithDependencies("tenant-1", "invoice-1", "PORTAL", deps),
      /portal rejected PDF/
    );
    assert.equal(successRecorded, false);
    assert.equal(failures[0]?.externalJobId, "portal-job-1");
    assert.match(failures[0]?.detail ?? "", /attachment/);
  });

  void test("records provider delivery failures without a successful transmission", async () => {
    const failures: FailureRecord[] = [];
    let successRecorded = false;
    const deps = dependencies({
      sendEmail() {
        throw new Error("SMTP relay unavailable");
      },
      async recordSuccessfulTransmission() {
        successRecorded = true;
      },
      async recordFailedTransmission(input) {
        failures.push(input);
      },
    });

    await assert.rejects(
      sendInvoiceWithDependencies("tenant-1", "invoice-1", "EMAIL", deps),
      /SMTP relay unavailable/
    );
    assert.equal(successRecorded, false);
    assert.match(failures[0]?.detail ?? "", /delivery/);
  });
});
