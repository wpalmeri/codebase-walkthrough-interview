import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AuthenticationError, AuthorizationError } from "../errors";
import {
  ADMIN_ROLES,
  BILLING_WRITE_ROLES,
  READ_ROLES,
  requirePrincipal,
  requireRole,
} from "./authorization";

function request(role?: "ADMIN" | "BILLING" | "VIEWER") {
  if (role === undefined) return { principal: undefined };
  return {
    principal: {
      subjectId: "subject-a",
      credentialId: "credential-a",
      kind: "OPERATOR_API_KEY" as const,
      role,
    },
  };
}

void describe("role authorization", () => {
  void test("requires a validated server principal", () => {
    assert.throws(() => requirePrincipal(request()), AuthenticationError);
    assert.equal(requirePrincipal(request("VIEWER")).credentialId, "credential-a");
  });

  void test("allows every role to read but only billing roles to mutate", () => {
    assert.equal(requireRole(request("VIEWER"), READ_ROLES).role, "VIEWER");
    assert.equal(requireRole(request("BILLING"), BILLING_WRITE_ROLES).role, "BILLING");
    assert.equal(requireRole(request("ADMIN"), ADMIN_ROLES).role, "ADMIN");
    assert.throws(() => requireRole(request("VIEWER"), BILLING_WRITE_ROLES), AuthorizationError);
    assert.throws(() => requireRole(request("BILLING"), ADMIN_ROLES), AuthorizationError);
  });
});
