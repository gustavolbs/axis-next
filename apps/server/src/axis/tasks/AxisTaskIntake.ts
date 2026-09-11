/**
 * W09 — AxisTaskIntake.
 *
 * Turns a local statement or a remote item reference into a fresh
 * AxisTaskExtension with the correct source binding. Reusing the same
 * commandId returns the same task (no duplicate thread allocation); the
 * dedupe is keyed on (scope, commandId) and falls back to
 * (scope, source.kind, source.issueKey/source.cardId).
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeCrypto from "node:crypto";

import {
  AxisContextProjectScope,
  AxisTaskAcceptanceCriterion,
  AxisTaskExtension,
  AxisTaskId,
  AxisTaskSource,
  AxisTaskStep,
  AxisTaskStepId,
  CommandId,
  ThreadId,
  TrimmedNonEmptyString,
  axisProjectScopeKey,
} from "@t3tools/contracts";

const MAX_TITLE_LENGTH = 240;
const MAX_ACCEPTANCE_LENGTH = 2_000;
const MAX_CRITERIA = 200;
const MAX_STEPS = 100;
const MAX_PROVENANCE = 2_000;
const projectScopeKeyFor = (scope: AxisContextProjectScope) => axisProjectScopeKey(scope.project);

export const AxisTaskIntakeSourceKind = Schema.Literals(["local", "jira", "trello"]);
export type AxisTaskIntakeSourceKind = typeof AxisTaskIntakeSourceKind.Type;

export const AxisTaskIntakeInputSchema = Schema.Struct({
  scope: AxisContextProjectScope,
  commandId: CommandId,
  threadId: ThreadId,
  source: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("local"),
      label: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
    }),
    Schema.Struct({
      kind: Schema.Literal("jira"),
      issueKey: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
      url: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(2_048))),
    }),
    Schema.Struct({
      kind: Schema.Literal("trello"),
      cardId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
      url: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(2_048))),
    }),
  ]),
  objective: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
  acceptanceCriteria: Schema.Array(
    Schema.Struct({
      text: TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_ACCEPTANCE_LENGTH)),
    }),
  ).check(Schema.isMaxLength(MAX_CRITERIA)),
  workflowVersion: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  steps: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(128))).check(
    Schema.isMaxLength(MAX_STEPS),
  ),
});
export type AxisTaskIntakeInput = typeof AxisTaskIntakeInputSchema.Type;

export const AxisTaskIntakeResultSchema = Schema.Struct({
  task: AxisTaskExtension,
  alreadyExists: Schema.Boolean,
});
export type AxisTaskIntakeResult = typeof AxisTaskIntakeResultSchema.Type;

export class AxisTaskIntakeError extends Schema.TaggedErrorClass<AxisTaskIntakeError>()(
  "AxisTaskIntakeError",
  {
    reason: Schema.Literals([
      "invalid_input",
      "scope_mismatch",
      "ambiguous_source",
      "duplicate",
      "persistence_failed",
    ]),
    message: Schema.String,
  },
) {}

type IntakeRow = {
  readonly id: unknown;
  readonly sourceKind: unknown;
  readonly sourceId: unknown;
  readonly taskJson: unknown;
};

const error = (reason: AxisTaskIntakeError["reason"], message: string) =>
  new AxisTaskIntakeError({ reason, message });

const fingerprintFor = (input: AxisTaskIntakeInput): string => {
  const payload = JSON.stringify({
    scope: projectScopeKeyFor(input.scope),
    commandId: input.commandId,
    sourceKind: input.source.kind,
    sourceId:
      input.source.kind === "local"
        ? `local:${input.source.label}`
        : input.source.kind === "jira"
          ? `jira:${input.source.issueKey}`
          : `trello:${input.source.cardId}`,
  });
  return `sha256:${NodeCrypto.createHash("sha256").update(payload, "utf8").digest("hex")}`;
};

const buildAcceptanceCriteria = (
  input: AxisTaskIntakeInput,
): ReadonlyArray<AxisTaskAcceptanceCriterion> => {
  if (input.acceptanceCriteria.length > 0) {
    return input.acceptanceCriteria.map((criterion, index) => ({
      id: AxisTaskStepId.make(`criterion-${index + 1}`),
      text: criterion.text,
    }));
  }
  return [
    {
      id: AxisTaskStepId.make("criterion-default"),
      text: "The task objective is observable in the running project.",
    },
  ];
};

const buildSteps = (
  workflowVersion: string,
  input: AxisTaskIntakeInput,
): ReadonlyArray<AxisTaskStep> => {
  const skillIds =
    input.steps.length > 0 ? input.steps : (["intake", "implement", "verify"] as const);
  return skillIds.map((skillId, index) => ({
    id: AxisTaskStepId.make(`step-${index + 1}`),
    skillId: AxisTaskStepId.make(skillId),
    status: "not-executed" as const,
    turnId: null,
    commandId: null,
    reason: null,
    startedAt: null,
    finishedAt: null,
  }));
};

const sourceFor = (input: AxisTaskIntakeInput): AxisTaskSource => {
  if (input.source.kind === "local") {
    return { kind: "local", label: input.source.label };
  }
  if (input.source.kind === "jira") {
    const url = input.source.url;
    return url !== undefined
      ? { kind: "jira", issueKey: input.source.issueKey, url }
      : { kind: "jira", issueKey: input.source.issueKey };
  }
  const url = input.source.url;
  return url !== undefined
    ? { kind: "trello", cardId: input.source.cardId, url }
    : { kind: "trello", cardId: input.source.cardId };
};

const buildTask = (input: AxisTaskIntakeInput): AxisTaskExtension => {
  const createdAt = DateTime.formatIso(DateTime.nowUnsafe());
  const id = AxisTaskId.make(
    `axis-task-${NodeCrypto.createHash("sha256")
      .update(fingerprintFor(input))
      .digest("hex")
      .slice(0, 24)}`,
  );
  return {
    id,
    scope: input.scope,
    threadId: input.threadId,
    source: sourceFor(input),
    title: input.objective.slice(0, MAX_TITLE_LENGTH),
    acceptanceCriteria: buildAcceptanceCriteria(input),
    workflowVersion: input.workflowVersion,
    steps: buildSteps(input.workflowVersion, input),
    status: "active",
    revision: 0,
    createdAt,
    updatedAt: createdAt,
  };
};

export const createAxisTaskFromIntake = (
  input: AxisTaskIntakeInput,
): Effect.Effect<AxisTaskIntakeResult, AxisTaskIntakeError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fingerprint = fingerprintFor(input);
    const rows = yield* sql<IntakeRow>`
      SELECT
        id AS id,
        source_kind AS sourceKind,
        source_id AS sourceId,
        task_json AS taskJson
      FROM axis_task_intake
      WHERE context_id = ${input.scope.contextId}
        AND scope_key = ${projectScopeKeyFor(input.scope)}
        AND command_id = ${input.commandId}
    `.pipe(Effect.mapError(() => error("persistence_failed", "Cannot read intake record.")));
    if (rows.length > 1) {
      return yield* error("duplicate", "Multiple intake rows matched this command id.");
    }
    if (rows.length === 1) {
      const existing = rows[0];
      if (existing === undefined) {
        return yield* error("persistence_failed", "Empty row detected on intake lookup.");
      }
      const task = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(AxisTaskExtension))(
        existing.taskJson,
      ).pipe(
        Effect.mapError(() => error("persistence_failed", "Cannot decode stored intake task.")),
      );
      return { task, alreadyExists: true };
    }
    const sourceId =
      input.source.kind === "local"
        ? `${input.commandId}`
        : input.source.kind === "jira"
          ? `jira:${input.source.issueKey}`
          : `trello:${input.source.cardId}`;
    const ambiguousRows: ReadonlyArray<IntakeRow> =
      input.source.kind === "local"
        ? []
        : yield* sql<IntakeRow>`
          SELECT
            id AS id,
            source_kind AS sourceKind,
            source_id AS sourceId,
            task_json AS taskJson
          FROM axis_task_intake
          WHERE context_id = ${input.scope.contextId}
            AND scope_key = ${projectScopeKeyFor(input.scope)}
            AND source_kind = ${input.source.kind}
            AND source_id = ${sourceId}
        `.pipe(
            Effect.mapError(() => error("persistence_failed", "Cannot read intake source rows.")),
          );
    if (ambiguousRows.length > 1) {
      return yield* error(
        "ambiguous_source",
        "Multiple existing tasks map to the same source. Reconcile manually.",
      );
    }
    if (ambiguousRows.length === 1) {
      const ambiguous = ambiguousRows[0];
      if (ambiguous === undefined) {
        return yield* error("persistence_failed", "Empty row detected on intake source lookup.");
      }
      const task = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(AxisTaskExtension))(
        ambiguous.taskJson,
      ).pipe(
        Effect.mapError(() => error("persistence_failed", "Cannot decode stored intake task.")),
      );
      return { task, alreadyExists: true };
    }
    const task = buildTask(input);
    yield* sql`
      INSERT INTO axis_task_intake (
        id, context_id, scope_key, command_id, source_kind, source_id,
        fingerprint, task_json, created_at
      )
      VALUES (
        ${task.id},
        ${input.scope.contextId},
        ${projectScopeKeyFor(input.scope)},
        ${input.commandId},
        ${input.source.kind},
        ${sourceId},
        ${fingerprint},
        ${JSON.stringify(task)},
        ${task.createdAt}
      )
    `.pipe(Effect.mapError(() => error("persistence_failed", "Cannot persist intake task.")));
    if (task.createdAt.length > MAX_PROVENANCE) {
      return yield* error("invalid_input", "Task timestamp exceeds the maximum provenance length.");
    }
    return { task, alreadyExists: false };
  });
