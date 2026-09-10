import { describe, expect, it } from "@effect/vitest";
import {
  AxisContextId,
  AxisWorkflowStepId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";

import type { AxisEffectiveContextResult } from "../../axis/projects/AxisEffectiveContext.ts";
import { formatAxisEffectiveContextInstructions } from "./ProviderCommandReactor.ts";

describe("Axis context instruction transport", () => {
  it("carries rejected learning conflicts alongside the effective execution requirements", () => {
    const context: AxisEffectiveContextResult = {
      scope: {
        contextId: AxisContextId.make("personal"),
        project: { environmentId: EnvironmentId.make("env"), projectId: ProjectId.make("project") },
      },
      provider: {
        environmentId: EnvironmentId.make("env"),
        instanceId: ProviderInstanceId.make("codex"),
      },
      step: "execute",
      profileRevision: 2,
      rules: [],
      workflow: [
        {
          id: AxisWorkflowStepId.make("verify"),
          title: "Verify",
          instruction: "Run focused tests",
          required: true,
          order: 0,
        },
      ],
      providerInstructions: [],
      tokenEfficiencyPolicies: [],
      sourceRefs: [],
      capabilities: [],
      conflicts: ["Learned change cannot relax required workflow step verify."],
      learningVersionIds: [],
      digest: "sha256:verified-context",
    };

    const instructions = formatAxisEffectiveContextInstructions(context);
    expect(instructions).toContain("Run focused tests (required)");
    expect(instructions).toContain(context.conflicts[0]);
    expect(instructions).toContain("report these conflicts");
    expect(instructions).toContain(context.digest);
  });
});
