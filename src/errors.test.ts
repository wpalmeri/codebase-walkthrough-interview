import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  NotFoundError,
  ProblemDetailsSchema,
  problemFromError,
} from "./errors";

void describe("problem details", () => {
  void test("enforces stable codes, HTTP error statuses, and closed response shapes", () => {
    const valid = {
      type: "urn:meridian:problem:conflict",
      title: "Conflict",
      status: 409,
      code: "VERSION_CONFLICT",
    };
    assert.equal(ProblemDetailsSchema.safeParse(valid).success, true);
    assert.equal(ProblemDetailsSchema.safeParse({ ...valid, status: 200 }).success, false);
    assert.equal(ProblemDetailsSchema.safeParse({ ...valid, code: "version-conflict" }).success, false);
    assert.equal(ProblemDetailsSchema.safeParse({ ...valid, debug: "secret" }).success, false);
  });

  void test("keeps the existing detail-only not-found constructor compatible", () => {
    const error = new NotFoundError("The record does not exist");
    assert.deepEqual(error.problem, {
      type: "urn:meridian:problem:not-found",
      title: "Not Found",
      status: 404,
      code: "NOT_FOUND",
      detail: "The record does not exist",
    });
  });

  void test("redacts database messages and metadata from mapped constraint problems", () => {
    const mapped = problemFromError(
      Object.assign(new Error("constraint on secret@example.com"), {
        code: "P2003",
        meta: { customerEmail: "secret@example.com" },
      })
    );

    assert.deepEqual(mapped, {
      type: "urn:meridian:problem:domain-invariant",
      title: "Unprocessable Entity",
      status: 422,
      code: "RELATED_RESOURCE_NOT_FOUND",
    });
    assert.doesNotMatch(JSON.stringify(mapped), /secret|customerEmail/);
  });
});
