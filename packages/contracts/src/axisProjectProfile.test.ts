import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  AxisContextProjectScope,
  AxisProjectProfile,
  AxisProjectProfileReplaceInput,
  AxisProjectScriptFact,
  AxisTypedChange,
  axisContextProjectScopeKey,
  axisProjectScopeKey,
} from "./axisProjectProfile.ts";
import { AxisProjectLocator } from "./axisContext.ts";

const decodeScope = Schema.decodeUnknownSync(AxisContextProjectScope);
const decodeFact = Schema.decodeUnknownSync(AxisProjectScriptFact);
const decodeProfile = Schema.decodeUnknownSync(AxisProjectProfile);
const decodeChange = Schema.decodeUnknownSync(AxisTypedChange);
const decodeReplace = Schema.decodeUnknownSync(AxisProjectProfileReplaceInput);
const decodeProject = Schema.decodeUnknownSync(AxisProjectLocator);

const scope = decodeScope({
  contextId: "company_a",
  project: { environmentId: "laptop", projectId: "venue-sites" },
});

describe("Axis project profile contracts", () => {
  it("requires a complete physical project scope", () => {
    expect(() => decodeScope({ contextId: "company_a" })).toThrow();
    expect(() => decodeScope({ project: { environmentId: "laptop" } })).toThrow();
  });

  it("keys physical projects by environment and project, never projectKey", () => {
    expect(axisProjectScopeKey(scope.project)).toBe('project:["laptop","venue-sites"]');
    expect(axisContextProjectScopeKey(scope)).toBe(
      'company_a\u0000project:["laptop","venue-sites"]',
    );
    expect(
      axisProjectScopeKey(decodeProject({ environmentId: "desktop", projectId: "venue-sites" })),
    ).not.toBe(axisProjectScopeKey(scope.project));
    expect(
      axisProjectScopeKey(decodeProject({ environmentId: "laptop", projectId: "other" })),
    ).not.toBe(axisProjectScopeKey(scope.project));
  });

  it("keeps script absence distinct from unreadable manifests", () => {
    expect(
      decodeFact({
        kind: "script",
        name: "test",
        status: "absent",
        sourceRef: "package-json",
      }).status,
    ).toBe("absent");
    expect(
      decodeFact({
        kind: "script",
        name: "test",
        status: "unreadable",
        sourceRef: "package-json",
        error: "permission denied",
      }).status,
    ).toBe("unreadable");
    expect(() =>
      decodeFact({ kind: "script", name: "test", status: "present", sourceRef: "package-json" }),
    ).toThrow();
  });

  it("accepts typed changes and rejects unknown executable operations", () => {
    const rule = {
      id: "run-tests",
      category: "command",
      text: "Run the focused test suite.",
      origin: "manifest",
      sourceRef: "package-json",
      sourceRevision: 1,
      paths: ["apps/web"],
      strength: "explicit",
      effect: "restriction",
      restriction: "Do not skip the focused suite.",
      defaultValue: null,
      condition: null,
    } as const;
    expect(decodeChange({ op: "set-rule", rule }).op).toBe("set-rule");
    expect(() => decodeChange({ op: "execute-shell", command: "rm -rf" })).toThrow();
    expect(() =>
      decodeReplace({ scope, expectedRevision: 2, changes: [{ op: "execute-shell" }] }),
    ).toThrow();
  });

  it("does not require JSON content for a project profile", () => {
    const profile = decodeProfile({
      scope,
      revision: 0,
      sources: [],
      facts: [],
      rules: [],
      manualDecisions: [],
      workflow: [],
      updatedAt: "2026-09-09T00:00:00.000Z",
    });
    expect(profile.rules).toEqual([]);
    expect(profile.tokenEfficiencyPolicies).toEqual([]);
  });
});
