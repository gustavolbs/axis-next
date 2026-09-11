import { describe, expect, it } from "@effect/vitest";
import { AxisContextId } from "@t3tools/contracts";

import { axisTaskScopeMatchesValidatedScope, resolveAxisCallerContextId } from "./ws.ts";

describe("Axis RPC caller context", () => {
  const contexts = [
    { id: AxisContextId.make("personal"), kind: "personal" as const },
    { id: AxisContextId.make("company"), kind: "company" as const },
  ];

  it("uses the authenticated subject before any requested scope", () => {
    expect(resolveAxisCallerContextId("company", contexts)).toBe("company");
  });

  it("keeps legacy sessions on the server-owned personal context", () => {
    expect(resolveAxisCallerContextId("desktop-bootstrap", contexts)).toBe("personal");
    expect(resolveAxisCallerContextId("desktop-bootstrap", [])).toBeUndefined();
  });

  it("rejects a task scope whose project or context changed during validation", () => {
    const requested = {
      contextId: "company",
      project: { environmentId: "env", projectId: "project" },
    } as const;
    expect(
      axisTaskScopeMatchesValidatedScope(requested, {
        ...requested,
        contextId: "personal",
      }),
    ).toBe(false);
    expect(axisTaskScopeMatchesValidatedScope(requested, requested)).toBe(true);
    expect(
      axisTaskScopeMatchesValidatedScope(requested, {
        ...requested,
        project: { ...requested.project, projectId: "different-project" },
      }),
    ).toBe(false);
  });
});
