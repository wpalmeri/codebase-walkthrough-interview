import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  bootstrapOperatorApiKey,
  OperatorApiKeyAdministrationError,
  parseOperatorApiKeyCliCommand,
  type OperatorApiKeyBootstrapStore,
} from "./operatorApiKeyLifecycle";

const pepper = "p".repeat(32);
const token = `mrd_abcdef1234_${"a".repeat(32)}`;

void describe("operator API-key bootstrap", () => {
  void test("creates one audited ADMIN credential without persisting its plaintext secret", async () => {
    let activeCount = 0;
    const writes: unknown[] = [];
    const store: OperatorApiKeyBootstrapStore = {
      async $transaction(operation) {
        return operation({
          operatorApiKey: {
            async count() { return activeCount; },
            async create({ data }) {
              activeCount += 1;
              writes.push(data);
              return { id: "operator-key-1", name: data.name, role: data.role, keyPrefix: data.keyPrefix, createdAt: new Date("2026-09-22T00:00:00.000Z") };
            },
          },
          auditEvent: { async create({ data }) { writes.push(data); return data; } },
        });
      },
    };

    const issued = await bootstrapOperatorApiKey(store, { name: "initial admin" }, pepper, { tokenGenerator: () => token });
    assert.equal(issued.role, "ADMIN");
    assert.equal(issued.token, token);
    assert.equal(JSON.stringify(writes).includes(token), false);
    assert.match(JSON.stringify(writes[0]), /hmac-sha256:v1:[a-f0-9]{64}/u);
    assert.match(JSON.stringify(writes[1]), /OPERATOR_API_KEY_ISSUED/u);
    await assert.rejects(
      bootstrapOperatorApiKey(store, { name: "second admin" }, pepper, { tokenGenerator: () => token }),
      (error: unknown) => error instanceof OperatorApiKeyAdministrationError && error.code === "ACTING_KEY_NOT_ACTIVE"
    );
  });

  void test("parses the simple bun bootstrap command without a redundant role flag", () => {
    assert.deepEqual(parseOperatorApiKeyCliCommand(["bootstrap", "--name", "initial admin"]), {
      action: "bootstrap",
      input: { name: "initial admin" },
    });
    assert.throws(
      () => parseOperatorApiKeyCliCommand(["bootstrap", "--name", "initial admin", "--role", "ADMIN"]),
      /unknown, duplicate, or incomplete/u
    );
  });
});
