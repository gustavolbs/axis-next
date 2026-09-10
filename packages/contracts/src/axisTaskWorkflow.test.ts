import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  AxisWorkflowAdmission,
  AxisWorkflowArtifact,
  AxisWorkflowRetryAdmission,
} from "./axisTaskWorkflow.ts";
const decodeAdmission = Schema.decodeUnknownSync(AxisWorkflowAdmission);
const decodeRetry = Schema.decodeUnknownSync(AxisWorkflowRetryAdmission);
const decodeArtifact = Schema.decodeUnknownSync(AxisWorkflowArtifact);

const admission = {
  scope: { contextId: "company", project: { environmentId: "env", projectId: "project" } },
  threadId: "thread",
  taskId: "task",
  stepId: "intake",
  commandId: "attempt",
  expectedRevision: 2,
  modelSelection: { instanceId: "codex", model: "gpt-5.6-luna" },
};

describe("Workflow transport boundaries", () => {
  it("accepts scoped identities while discarding client task content", () => {
    const decoded = decodeAdmission({
      ...admission,
      task: { title: "Injected" },
    });
    expect(decoded).toEqual(admission);
    expect(() => decodeAdmission({ ...admission, expectedRevision: -1 })).toThrow();
    expect(() =>
      decodeAdmission({
        ...admission,
        scope: { contextId: "company" },
      }),
    ).toThrow();
  });
  it("requires the previous immutable attempt identity for retry", () => {
    expect(() => decodeRetry(admission)).toThrow();
    expect(
      decodeRetry({
        ...admission,
        previousCommandId: "previous",
      }).previousCommandId,
    ).toBe("previous");
  });
  it("bounds provider document payloads and requires a canonical turn", () => {
    const artifact = {
      kind: "document",
      skillId: "intake",
      execution: { threadId: "run", turnId: "turn", commandId: "attempt" },
      messageId: "message",
      requestDigest: "digest",
      text: "Analysis",
    };
    expect(decodeArtifact(artifact).text).toBe("Analysis");
    expect(() => decodeArtifact({ ...artifact, text: "x".repeat(64_001) })).toThrow();
    expect(() =>
      decodeArtifact({ ...artifact, execution: { ...artifact.execution, turnId: null } }),
    ).toThrow();
  });
});
