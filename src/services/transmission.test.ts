import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createJsonTransmissionTelemetry,
  createPortalJob,
  sendEmail,
  submitToClearinghouse,
  TransmissionLogEventSchema,
} from "./transmission";

void describe("email transmission", () => {
  void test("attaches the rendered invoice before delivering the message", () => {
    const events: string[] = [];
    const pdf = Buffer.from("invoice");

    const result = sendEmail("billing@example.com", "INV-00001", pdf, {
      attachDocument(method, reference, attachedPdf) {
        events.push(`attach:${method}:${reference}`);
        assert.equal(attachedPdf, pdf);
      },
      deliver(to, invoiceNumber) {
        events.push(`deliver:${to}:${invoiceNumber}`);
      },
    });

    assert.deepEqual(events, [
      "attach:EMAIL:email:INV-00001",
      "deliver:billing@example.com:INV-00001",
    ]);
    assert.deepEqual(result, {
      status: "SENT",
      detail: "Emailed to billing@example.com",
    });
  });

  void test("does not deliver or report success when attachment fails", () => {
    let delivered = false;

    assert.throws(
      () =>
        sendEmail("billing@example.com", "INV-00001", Buffer.from("invoice"), {
          attachDocument() {
            throw new Error("carrier rejected attachment");
          },
          deliver() {
            delivered = true;
          },
        }),
      /carrier rejected attachment/
    );
    assert.equal(delivered, false);
  });

  void test("emits only the approved PII-free operational telemetry shape", () => {
    const lines: string[] = [];
    const telemetry = createJsonTransmissionTelemetry((line) => lines.push(line));
    const recipient = "billing@example.com";
    const invoiceNumber = "INV-PRIVATE-00001";
    const portalAccount = "PORTAL-CUSTOMER-SECRET";
    const clearinghouseId = "CLEARINGHOUSE-CUSTOMER-SECRET";

    sendEmail(recipient, invoiceNumber, Buffer.from("invoice"), {
      attachDocument() {},
      deliver() {},
      telemetry,
    });
    createPortalJob(portalAccount, invoiceNumber, telemetry);
    submitToClearinghouse(clearinghouseId, invoiceNumber, telemetry);

    assert.equal(lines.length, 3);
    for (const line of lines) {
      assert.equal(TransmissionLogEventSchema.safeParse(JSON.parse(line)).success, true);
      assert.doesNotMatch(line, /billing@example\.com|INV-PRIVATE|PORTAL-CUSTOMER|CLEARINGHOUSE-CUSTOMER/u);
    }
    assert.throws(() =>
      TransmissionLogEventSchema.parse({
        level: "info",
        event: "DELIVERY_ACCEPTED",
        method: "EMAIL",
        status: "SENT",
        recipient,
      })
    );
  });
});
