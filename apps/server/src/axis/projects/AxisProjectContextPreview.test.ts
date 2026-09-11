import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  AxisContextCatalog,
  AxisContextProjectScope,
  AxisProviderInstanceLocator,
  AxisProjectRule,
  AxisLearningEvidence,
  AxisLearningLifecycleEventId,
  AxisLearningProposalDraft,
  AxisLearningVersionId,
  CommandId,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  AxisContextCatalogStore,
  layer as catalogLayer,
} from "../contexts/AxisContextCatalogStore.ts";
import { AxisLearningStore, layer as learningLayer } from "../learning/AxisLearningStore.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { AxisProjectProfileStore, layer as profileLayer } from "./AxisProjectProfileStore.ts";
import { AxisProjectScopeCaller, layer as scopeLayer } from "./AxisProjectScope.ts";
import { layer as effectiveLayer } from "./AxisEffectiveContext.ts";
import { AxisProjectContextPreview, layer as previewLayer } from "./AxisProjectContextPreview.ts";

const decodeScope = Schema.decodeUnknownSync(AxisContextProjectScope);
const decodeProvider = Schema.decodeUnknownSync(AxisProviderInstanceLocator);
const decodeCaller = Schema.decodeUnknownSync(AxisProjectScopeCaller);
const decodeRule = Schema.decodeUnknownSync(AxisProjectRule);
const decodeEvidence = Schema.decodeUnknownSync(AxisLearningEvidence);
const decodeProposalDraft = Schema.decodeUnknownSync(AxisLearningProposalDraft);
const scope = decodeScope({
  contextId: "company",
  project: { environmentId: "env", projectId: "project" },
});
const conflictScope = decodeScope({
  contextId: "company",
  project: { environmentId: "env", projectId: "project-conflict" },
});
const provider = decodeProvider({ environmentId: "env", instanceId: "codex" });
const caller = decodeCaller({ environmentId: "env", contextId: "company" });
const learningScope = { contextId: scope.contextId, project: scope.project };
const conflictLearningScope = {
  contextId: conflictScope.contextId,
  project: conflictScope.project,
};
const now = "2026-09-10T00:00:00.000Z";

const catalog = Schema.decodeUnknownSync(AxisContextCatalog)({
  contexts: [
    { id: "personal", kind: "personal", name: "Personal", createdAt: now, updatedAt: now },
    { id: "company", kind: "company", name: "Company", createdAt: now, updatedAt: now },
  ],
  projectBindings: [{ contextId: "company", project: scope.project }],
  providerOwnerships: [{ contextId: "company", provider }],
  providerAccessGrants: [],
  capabilities: [],
  workHubSources: [],
});

const dependencies = Layer.mergeAll(
  SqlitePersistenceMemory,
  Layer.succeed(ServerEnvironment, {
    getEnvironmentId: Effect.succeed("env"),
    getDescriptor: Effect.die("unused"),
  } as never),
  Layer.succeed(ProjectionSnapshotQuery, {
    getProjectShellById: () => Effect.succeed(Option.some({} as never)),
  } as never),
);
const stores = Layer.mergeAll(catalogLayer, profileLayer, learningLayer).pipe(
  Layer.provideMerge(dependencies),
);
const authorized = scopeLayer.pipe(Layer.provideMerge(Layer.merge(stores, dependencies)));
const resolver = effectiveLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(stores, authorized, dependencies)),
);
const testLayer = previewLayer.pipe(
  Layer.provideMerge(Layer.merge(resolver, Layer.mergeAll(stores, authorized, dependencies))),
);
const layer = it.layer(testLayer);

const input = (
  overrides: Partial<Parameters<AxisProjectContextPreview["Service"]["resolve"]>[0]> = {},
) => ({
  caller,
  scope,
  provider,
  driver: ProviderDriverKind.make("codex"),
  model: "gpt-5",
  step: "verify",
  paths: ["src/main.ts"],
  ...overrides,
});

layer("AxisProjectContextPreview", (it) => {
  it.effect("returns the server-resolved inherited, learning, and manual result", () =>
    Effect.gen(function* () {
      const catalogs = yield* AxisContextCatalogStore;
      const catalogSnapshot = yield* catalogs.get;
      yield* catalogs.replace({ expectedRevision: catalogSnapshot.revision, catalog });
      const profiles = yield* AxisProjectProfileStore;
      yield* profiles.replace(scope, 0, [
        {
          op: "set-rule",
          rule: decodeRule({
            id: "shared-rule",
            category: "convention",
            text: "Inherited project convention.",
            origin: "inherited",
            sourceRef: "profile",
            sourceRevision: 1,
            paths: ["src"],
            strength: "inferred",
            effect: "preference",
            restriction: null,
            defaultValue: null,
            condition: null,
          }),
        },
        {
          op: "set-rule",
          rule: decodeRule({
            id: "manual",
            category: "test-policy",
            text: "Manual project decision.",
            origin: "manual",
            sourceRef: "profile",
            sourceRevision: 2,
            paths: ["src"],
            strength: "explicit",
            effect: "restriction",
            restriction: "Keep verification focused.",
            defaultValue: null,
            condition: null,
          }),
        },
      ]);

      const learning = yield* AxisLearningStore;
      const evidence = decodeEvidence({
        id: "evidence_preview",
        provenance: {
          contextId: "company",
          scope,
          sourceKind: "thread-turn",
          sourceId: "thread:turn",
          observedAt: now,
          fingerprint: "preview-fingerprint",
        },
        summary: "A learned verification rule.",
        createdAt: now,
        expiresAt: "2026-10-10T00:00:00.000Z",
      });
      yield* learning.recordEvidence(evidence);
      const draft = decodeProposalDraft({
        id: "proposal_preview",
        contextId: "company",
        scope,
        kind: "provider-skill",
        targetKey: "provider:codex:step:verify",
        title: "Learn verification",
        rationale: "Observed repeatedly.",
        evidenceIds: [evidence.id],
        change: {
          op: "set-rule",
          rule: decodeRule({
            id: "shared-rule",
            category: "test-policy",
            text: "Run the focused verification.",
            origin: "learning",
            sourceRef: "learning",
            sourceRevision: 1,
            paths: ["src"],
            strength: "inferred",
            effect: "preference",
            restriction: null,
            defaultValue: null,
            condition: null,
          }),
        },
      });
      yield* learning.createProposal(draft, now);
      yield* learning.submitForReview(draft.id, learningScope, {
        eventId: AxisLearningLifecycleEventId.make("submit_preview"),
        actor: "user:test",
        createdAt: now,
      });
      const version = yield* learning.approve(
        draft.id,
        learningScope,
        AxisLearningVersionId.make("version_preview"),
        {
          eventId: AxisLearningLifecycleEventId.make("approve_preview"),
          actor: "user:test",
          createdAt: now,
        },
      );
      yield* learning.activate(
        scope,
        draft.targetKey,
        version.id,
        0,
        CommandId.make("activate_preview"),
      );

      const preview = yield* (yield* AxisProjectContextPreview).resolve(input());
      assert.deepEqual(
        preview.rules.map((rule) => rule.id),
        ["manual", "shared-rule"],
      );
      assert.equal(preview.rules.find((rule) => rule.id === "shared-rule")?.origin, "learning");
      assert.include(preview.sources, "profile");
      assert.include(preview.sources, "learning");
      assert.deepEqual(preview.learningVersionIds, [version.id]);
      assert.deepEqual(preview.conflicts, []);
      assert.equal(preview.profileRevision, 1);
      assert.match(preview.digest, /^sha256:/);
    }),
  );

  it.effect("preserves resolver scope authorization", () =>
    Effect.gen(function* () {
      const catalogs = yield* AxisContextCatalogStore;
      const catalogSnapshot = yield* catalogs.get;
      yield* catalogs.replace({ expectedRevision: catalogSnapshot.revision, catalog });
      const error = yield* Effect.flip(
        (yield* AxisProjectContextPreview).resolve(
          input({ caller: decodeCaller({ environmentId: "env", contextId: "personal" }) }),
        ),
      );
      assert.equal(error._tag, "AxisEffectiveContextValidationError");
      assert.include(error.message, "another Axis context");
    }),
  );

  it.effect("reports a learning override of a manual rule as a resolver conflict", () =>
    Effect.gen(function* () {
      const catalogs = yield* AxisContextCatalogStore;
      const catalogSnapshot = yield* catalogs.get;
      yield* catalogs.replace({
        expectedRevision: catalogSnapshot.revision,
        catalog: {
          ...catalog,
          projectBindings: [
            ...catalog.projectBindings,
            { contextId: conflictScope.contextId, project: conflictScope.project },
          ],
        },
      });
      const profiles = yield* AxisProjectProfileStore;
      yield* profiles.replace(conflictScope, 0, [
        {
          op: "set-rule",
          rule: decodeRule({
            id: "manual-policy",
            category: "test-policy",
            text: "Manual policy.",
            origin: "manual",
            sourceRef: "profile",
            sourceRevision: 1,
            paths: ["src"],
            strength: "explicit",
            effect: "restriction",
            restriction: "Keep the manual policy.",
            defaultValue: null,
            condition: null,
          }),
        },
      ]);

      const learning = yield* AxisLearningStore;
      const evidence = decodeEvidence({
        id: "evidence_override",
        provenance: {
          contextId: "company",
          scope: conflictScope,
          sourceKind: "thread-turn",
          sourceId: "thread:override",
          observedAt: now,
          fingerprint: "override-fingerprint",
        },
        summary: "An invalid learned override.",
        createdAt: now,
        expiresAt: "2026-10-10T00:00:00.000Z",
      });
      yield* learning.recordEvidence(evidence);
      const draft = decodeProposalDraft({
        id: "proposal_override",
        contextId: "company",
        scope: conflictScope,
        kind: "provider-skill",
        targetKey: "provider:codex:step:verify",
        title: "Override manual policy",
        rationale: "This must be rejected by the effective resolver.",
        evidenceIds: [evidence.id],
        change: {
          op: "set-rule",
          rule: decodeRule({
            id: "manual-policy",
            category: "test-policy",
            text: "Learned replacement.",
            origin: "learning",
            sourceRef: "learning",
            sourceRevision: 1,
            paths: ["src"],
            strength: "inferred",
            effect: "restriction",
            restriction: "Attempt to replace the manual policy.",
            defaultValue: null,
            condition: null,
          }),
        },
      });
      yield* learning.createProposal(draft, now);
      yield* learning.submitForReview(draft.id, conflictLearningScope, {
        eventId: AxisLearningLifecycleEventId.make("submit_override"),
        actor: "user:test",
        createdAt: now,
      });
      const version = yield* learning.approve(
        draft.id,
        conflictLearningScope,
        AxisLearningVersionId.make("version_override"),
        {
          eventId: AxisLearningLifecycleEventId.make("approve_override"),
          actor: "user:test",
          createdAt: now,
        },
      );
      yield* learning.activate(
        conflictScope,
        draft.targetKey,
        version.id,
        0,
        CommandId.make("activate_override"),
      );

      const preview = yield* (yield* AxisProjectContextPreview).resolve(
        input({ scope: conflictScope }),
      );
      assert.deepEqual(
        preview.rules.map((rule) => rule.id),
        ["manual-policy"],
      );
      assert.equal(preview.rules[0]?.text, "Manual policy.");
      assert.deepEqual(preview.learningVersionIds, []);
      assert.deepEqual(preview.conflicts, [
        "Learned change cannot override manual rule manual-policy.",
      ]);
    }),
  );
});
