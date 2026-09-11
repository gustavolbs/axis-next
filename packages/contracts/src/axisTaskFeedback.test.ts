import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { AxisTaskFeedbackError, AxisTaskFeedbackRequest } from "./axisTaskFeedback.ts";

const decodeRequest = Schema.decodeUnknownSync(AxisTaskFeedbackRequest, {
  onExcessProperty: "error",
});
const decodeError = Schema.decodeUnknownSync(AxisTaskFeedbackError, {
  onExcessProperty: "error",
});

const request = {
  scope: { contextId: "company", project: { environmentId: "env", projectId: "project" } },
  taskId: "task",
  threadId: "thread",
  stepId: "step",
  commandId: "command",
};

describe("Axis task feedback contracts", () => {
  it("accepts only canonical execution identities and an optional expected turn", () => {
    expect(decodeRequest(request)).toEqual(request);
    expect(decodeRequest({ ...request, expectedTurnId: "turn" }).expectedTurnId).toBe("turn");
  });

  it("rejects client-derived feedback claims and invalid canonical values", () => {
    for (const derivedField of ["outcome", "summary", "provider", "observedAt", "claims"])
      expect(() => decodeRequest({ ...request, [derivedField]: "forged" })).toThrow();
    expect(() => decodeRequest({ ...request, taskId: " " })).toThrow();
    expect(() => decodeRequest({ ...request, expectedTurnId: "" })).toThrow();
    expect(() => decodeRequest({ ...request, scope: { contextId: "company" } })).toThrow();
  });

  it("serializes only known reasons with a bounded message", () => {
    expect(
      decodeError({
        _tag: "AxisTaskFeedbackError",
        reason: "not_terminal",
        message: "Feedback requires a terminal execution.",
      }),
    ).toMatchObject({ reason: "not_terminal", message: "Feedback requires a terminal execution." });
    expect(() =>
      decodeError({
        _tag: "AxisTaskFeedbackError",
        reason: "forged",
        message: "Invalid reason.",
      }),
    ).toThrow();
    expect(() =>
      decodeError({
        _tag: "AxisTaskFeedbackError",
        reason: "invalid_input",
        message: "x".repeat(513),
      }),
    ).toThrow();
  });
});
