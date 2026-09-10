import { describe, expect, it } from "@effect/vitest";
import { AuthAdministrativeScopes, AuthStandardClientScopes, AxisContextId } from "@t3tools/contracts";

import { axisTaskScopeMatchesValidatedScope, resolveAxisCallerContextId } from "./ws.ts";

describe("Axis RPC caller context", () => {
  const contexts = [
    { id: AxisContextId.make("personal"), kind: "personal" as const },
    { id: AxisContextId.make("company"), kind: "company" as const },
  ];

  it("uses the authenticated subject before any requested scope", () => {
    expect(resolveAxisCallerContextId({ subject: "company", scopes: AuthStandardClientScopes }, contexts, AxisContextId.make("personal"))).toBe("company");
  });

  it("keeps legacy sessions on the server-owned personal context", () => {
    const session = { subject: "desktop-bootstrap", scopes: AuthStandardClientScopes };
    expect(resolveAxisCallerContextId(session, contexts, AxisContextId.make("company"))).toBe("personal");
    expect(resolveAxisCallerContextId(session, [])).toBeUndefined();
  });

  it("lets environment administrators select only existing catalog contexts", () => {
    const session = { subject: "desktop-bootstrap", scopes: AuthAdministrativeScopes };
    expect(resolveAxisCallerContextId(session, contexts, AxisContextId.make("company"))).toBe("company");
    expect(resolveAxisCallerContextId(session, contexts, AxisContextId.make("missing"))).toBeUndefined();
    expect(resolveAxisCallerContextId(session, contexts)).toBe("personal");
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
