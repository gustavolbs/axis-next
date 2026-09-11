import { AxisLearningEngine } from "./AxisLearningEngine.ts";
import {
  evaluateAxisLearningProposal,
  type AxisLearningEvaluationPreviousDecision,
} from "./AxisLearningEvaluation.ts";
import * as AxisLearningStore from "./AxisLearningStore.ts";
import * as AxisProjectProfileStore from "../projects/AxisProjectProfileStore.ts";
import {
  AxisLearningEngineError,
  type AxisLearningEngineRunResult,
} from "../../../../../packages/contracts/src/axisLearningEngine.ts";
import {
  AxisLearningEvidenceId,
  AxisLearningLifecycleEventId,
  AxisLearningProposalId,
  AxisLearningValidationError,
  type AxisLearningEvidence,
  type AxisLearningProposal,
} from "../../../../../packages/contracts/src/axisLearning.ts";
import type { AxisLearningStoreError } from "../../../../../packages/contracts/src/axisLearning.ts";
import type { AxisContextProjectScope } from "../../../../../packages/contracts/src/axisProjectProfile.ts";
import {
  type AxisLearningImprovementRun,
  type AxisLearningRequestImprovementsInput,
} from "../../../../../packages/contracts/src/rpc.ts";
import { CommandId } from "../../../../../packages/contracts/src/baseSchemas.ts";
import type { AxisLearningEngineRequest } from "../../../../../packages/contracts/src/axisLearningEngine.ts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";

type AxisLearningServiceError =
  | AxisLearningEngineError
  | AxisLearningStoreError
  | AxisProjectProfileStore.AxisProjectProfileStoreError;

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

export class AxisLearningService extends Context.Service<
  AxisLearningService,
  {
    readonly requestImprovements: (
      input: AxisLearningRequestImprovementsInput,
    ) => Effect.Effect<AxisLearningImprovementRun, AxisLearningServiceError>;
  }
>()("t3/axis/learning/AxisLearningService") {}

export const make = Effect.gen(function* () {
  const engine = yield* AxisLearningEngine;
  const learning = yield* AxisLearningStore.AxisLearningStore;
  const profiles = yield* AxisProjectProfileStore.AxisProjectProfileStore;

  const makeRunId = (commandId: CommandId) =>
    `axis-learning-run-${NodeCrypto.createHash("sha256").update(commandId).digest("hex")}`;
  const makeProposalId = (commandId: CommandId, index: number) =>
    AxisLearningProposalId.make(
      `axis-learning-proposal-${NodeCrypto.createHash("sha256")
        .update(`${commandId}:${index}`)
        .digest("hex")}`,
    );
  const makeEventId = (commandId: CommandId, index: number) =>
    AxisLearningLifecycleEventId.make(
      `axis-learning-submit-${NodeCrypto.createHash("sha256")
        .update(`${commandId}:${index}`)
        .digest("hex")}`,
    );

  const selectEvidence = (
    allEvidence: ReadonlyArray<AxisLearningEvidence>,
    input: AxisLearningRequestImprovementsInput,
  ): Effect.Effect<ReadonlyArray<AxisLearningEvidence>, AxisLearningStoreError> => {
    const requested = new Set(input.evidenceIds);
    const selected = allEvidence.filter((evidence) => requested.has(evidence.id));
    return selected.length === requested.size
      ? Effect.succeed(selected)
      : Effect.fail(
          new AxisLearningValidationError({
            message: "Every selected Learning evidence record must belong to the project.",
          }),
        );
  };

  const requestImprovements = (
    input: AxisLearningRequestImprovementsInput,
  ): Effect.Effect<AxisLearningImprovementRun, AxisLearningServiceError> =>
    Effect.gen(function* () {
      const scope: AxisContextProjectScope = input.scope;
      const [profile, allEvidence, snapshot] = yield* Effect.all([
        profiles.get(scope),
        learning.listEvidence(scope.contextId, scope),
        learning.getSnapshot(scope.contextId, scope),
      ]);
      const examples = yield* selectEvidence(allEvidence, input);
      const evidenceRefs = examples.map((evidence) => ({
        id: evidence.id,
        contextId: evidence.provenance.contextId,
        ...(evidence.provenance.scope === undefined ? {} : { scope: evidence.provenance.scope }),
      }));
      const content = encodeJson({
        scope,
        evidence: examples.map(({ id, summary, provenance }) => ({
          id,
          summary,
          sourceKind: provenance.sourceKind,
          sourceId: provenance.sourceId,
          fingerprint: provenance.fingerprint,
        })),
        profile: {
          sources: profile.sources,
          facts: profile.facts,
          rules: profile.rules,
          workflow: profile.workflow,
        },
      });
      const request: AxisLearningEngineRequest = {
        contextId: scope.contextId,
        scope,
        evidenceRefs,
        content,
        deadlineMs: input.deadlineMs,
      };
      const engineResult: AxisLearningEngineRunResult = yield* engine.run(request);
      const base = {
        id: makeRunId(input.commandId),
        commandId: input.commandId,
        engine: engine.status,
        proposals: [] as ReadonlyArray<AxisLearningProposal>,
        reason: null as string | null,
      };
      if (engineResult.status === "unavailable") {
        return { ...base, status: "unavailable", reason: engineResult.message };
      }
      if (engineResult.status === "no-change") {
        return { ...base, status: "no-change", reason: engineResult.reason };
      }

      const previousDecisions: ReadonlyArray<AxisLearningEvaluationPreviousDecision> =
        snapshot.proposals.map((proposal) => ({
          contextId: proposal.contextId,
          ...(proposal.scope === undefined ? {} : { scope: proposal.scope }),
          kind: proposal.kind,
          targetKey: proposal.targetKey,
          ...(proposal.targetProvider === undefined
            ? {}
            : { targetProvider: proposal.targetProvider }),
          evidenceIds: proposal.evidenceIds,
          change: proposal.change,
          status: proposal.status,
        }));
      const accepted = engineResult.proposals
        .map((candidate) =>
          evaluateAxisLearningProposal({
            candidate,
            sources: profile.sources,
            rules: profile.rules,
            examples,
            previousDecisions,
          }),
        )
        .filter((result) => result.status === "accepted-for-review");
      const proposals = yield* Effect.forEach(accepted, (evaluation, index) => {
        const id = makeProposalId(input.commandId, index);
        const draft = {
          id,
          contextId: scope.contextId,
          scope,
          kind: evaluation.candidate.kind,
          targetKey: evaluation.candidate.targetKey,
          ...(evaluation.candidate.targetProvider === undefined
            ? {}
            : { targetProvider: evaluation.candidate.targetProvider }),
          title: evaluation.candidate.title,
          rationale: evaluation.candidate.rationale,
          evidenceIds: evaluation.candidate.evidenceIds.map((id) =>
            AxisLearningEvidenceId.make(id),
          ),
          change: evaluation.candidate.change,
        } satisfies Parameters<AxisLearningStore.AxisLearningStore["Service"]["createProposal"]>[0];
        return learning.createProposal(draft, DateTime.formatIso(DateTime.nowUnsafe())).pipe(
          Effect.catchTag("AxisLearningConflictError", () => learning.getProposal(id, scope)),
          Effect.flatMap((proposal) =>
            proposal.status === "in-review"
              ? Effect.succeed(proposal)
              : learning.submitForReview(id, scope, {
                  eventId: makeEventId(input.commandId, index),
                  actor: "axis-learning-engine",
                  note: "Generated from bounded project evidence and accepted for user review.",
                  createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
                }),
          ),
        );
      });
      return {
        ...base,
        status: proposals.length === 0 ? "no-change" : "proposals",
        proposals,
        reason:
          proposals.length === 0 ? "No candidate passed the bounded Learning evaluation." : null,
      };
    });

  return { requestImprovements };
});

export const layer = Layer.effect(AxisLearningService, make);
