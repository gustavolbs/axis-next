import { describe, expect, it } from "vite-plus/test";

import { AxisContextId, AxisProjectProfile, AxisProjectRule } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  buildProjectPatternsModel,
  buildResetOverrideInput,
  buildRuleReplaceInput,
  buildRuleOverrideChange,
} from "./projectPatternsModel";

const decodeProfile = Schema.decodeUnknownSync(AxisProjectProfile);
const decodeRule = Schema.decodeUnknownSync(AxisProjectRule);

const scope = (projectId: string) => ({
  contextId: AxisContextId.make("company"),
  project: { environmentId: "remote", projectId },
});

const rule = (overrides: Record<string, unknown> = {}) =>
  decodeRule({
    id: "policy",
    category: "convention",
    text: "Use the repository convention.",
    origin: "manifest",
    sourceRef: "manifest",
    sourceRevision: 2,
    paths: [],
    strength: "explicit",
    effect: "preference",
    restriction: null,
    defaultValue: null,
    condition: null,
    ...overrides,
  });

const profile = (projectId: string, rules: ReadonlyArray<AxisProjectRule>) =>
  decodeProfile({
    scope: scope(projectId),
    revision: 7,
    sources: [
      {
        id: "manifest",
        kind: "manifest",
        path: "package.json",
        digest: "digest",
        observedAt: "2026-09-10T00:00:00.000Z",
      },
    ],
    facts: [],
    rules,
    manualDecisions: [],
    workflow: [],
    updatedAt: "2026-09-10T00:00:00.000Z",
  });

describe("project patterns model", () => {
  it("separates inherited origin from a project override and resets with the loaded revision", () => {
    const inherited = rule();
    const override = rule({ origin: "manual", text: "Use the local convention." });
    const model = buildProjectPatternsModel({
      profile: profile("remote-project", [inherited, override]),
      inheritedRules: [inherited],
    });
    const entry = model.rules[0]!;

    expect(entry.isInherited).toBe(true);
    expect(entry.isOverridden).toBe(true);
    expect(entry.origin).toBe("manual");
    expect(entry.effectiveRule.text).toBe("Use the local convention.");
    expect(buildResetOverrideInput(model, entry.id)).toEqual({
      scope: scope("remote-project"),
      ruleId: entry.id,
      expectedRevision: 7,
    });
  });

  it("does not expose an inherited restriction as an editable override", () => {
    const inherited = rule({
      effect: "restriction",
      restriction: "Never write outside the workspace.",
      text: "Only write inside the workspace.",
    });
    const model = buildProjectPatternsModel({
      profile: profile("remote-project", [inherited]),
      inheritedRules: [inherited],
    });
    const entry = model.rules[0]!;

    expect(entry.restrictionLocked).toBe(true);
    expect(buildRuleOverrideChange(model, entry.id, "Write anywhere.")).toEqual({
      ok: false,
      code: "inherited-restriction",
      message: "Inherited restrictions are locked and cannot be relaxed by a project override.",
    });
  });

  it("keeps a remote member's physical scope and revision in a save input", () => {
    const inherited = rule();
    const model = buildProjectPatternsModel({
      profile: profile("remote-project", [inherited]),
      inheritedRules: [inherited],
    });

    expect(buildRuleReplaceInput(model, inherited.id, "Use the remote convention.")).toEqual({
      scope: scope("remote-project"),
      expectedRevision: 7,
      changes: [
        {
          op: "set-rule",
          rule: {
            ...inherited,
            text: "Use the remote convention.",
            origin: "manual",
          },
        },
      ],
    });
  });

  it("keeps saves for logical-group members physically isolated", () => {
    const inherited = rule();
    const localModel = buildProjectPatternsModel({
      profile: profile("local-project", [inherited]),
      inheritedRules: [inherited],
    });
    const remoteModel = buildProjectPatternsModel({
      profile: profile("remote-project", [inherited]),
      inheritedRules: [inherited],
    });

    const localInput = buildRuleReplaceInput(localModel, inherited.id, "Local pattern.");
    const remoteInput = buildRuleReplaceInput(remoteModel, inherited.id, "Remote pattern.");
    expect("scope" in localInput && localInput.scope.project.projectId).toBe("local-project");
    expect("scope" in remoteInput && remoteInput.scope.project.projectId).toBe("remote-project");
    expect("scope" in localInput && "scope" in remoteInput && localInput.scope).not.toEqual(
      "scope" in remoteInput && remoteInput.scope,
    );
  });

  it("does not let a relaxed persisted override replace an inherited restriction", () => {
    const inherited = rule({
      effect: "restriction",
      restriction: "Never write outside the workspace.",
      text: "Only write inside the workspace.",
    });
    const persistedOverride = rule({
      origin: "manual",
      effect: "restriction",
      restriction: "Never write outside the workspace.",
      text: "Write anywhere.",
    });
    const model = buildProjectPatternsModel({
      profile: profile("remote-project", [inherited, persistedOverride]),
      inheritedRules: [inherited],
    });

    expect(model.rules[0]?.effectiveRule.text).toBe(inherited.text);
    expect(model.rules[0]?.invalidRestrictionOverride).toBe(true);
    expect(model.rules[0]?.isOverridden).toBe(true);
  });
});
