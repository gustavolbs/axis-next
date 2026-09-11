/** Portable task metadata layered on top of T3 Threads and Turns. */
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

import { AxisCapabilityId } from "./axisContext.ts";
import { AxisContextProjectScope } from "./axisProjectProfile.ts";
import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TurnId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

const taskId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.check(
    Schema.isMaxLength(128),
    Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  ).pipe(Schema.brand(brand));

export const AxisTaskId = taskId("AxisTaskId");
export type AxisTaskId = typeof AxisTaskId.Type;
export const AxisSkillId = taskId("AxisSkillId");
export type AxisSkillId = typeof AxisSkillId.Type;
export const AxisTaskStepId = taskId("AxisTaskStepId");
export type AxisTaskStepId = typeof AxisTaskStepId.Type;

export const AxisTaskPurpose = Schema.Literals(["execution", "onboarding"]);
export type AxisTaskPurpose = typeof AxisTaskPurpose.Type;

export const AxisTaskSource = Schema.Union([
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
]);
export type AxisTaskSource = typeof AxisTaskSource.Type;

export const AxisTaskAcceptanceCriterion = Schema.Struct({
  id: AxisTaskStepId,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
});
export type AxisTaskAcceptanceCriterion = typeof AxisTaskAcceptanceCriterion.Type;

export const AxisTaskStepStatus = Schema.Literals([
  "not-applicable",
  "not-executed",
  "failed",
  "completed",
]);
export type AxisTaskStepStatus = typeof AxisTaskStepStatus.Type;

/** A step references canonical T3 execution records rather than copying them. */
export const AxisTaskStep = Schema.Struct({
  id: AxisTaskStepId,
  skillId: AxisSkillId,
  status: AxisTaskStepStatus,
  turnId: Schema.NullOr(TurnId),
  commandId: Schema.NullOr(CommandId),
  reason: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(2_000))),
  startedAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
});
export type AxisTaskStep = typeof AxisTaskStep.Type;

const axisTaskFields = {
  id: AxisTaskId,
  scope: AxisContextProjectScope,
  threadId: ThreadId,
  source: Schema.optionalKey(AxisTaskSource),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(240)),
  acceptanceCriteria: Schema.Array(AxisTaskAcceptanceCriterion).check(Schema.isMaxLength(200)),
  workflowVersion: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  steps: Schema.Array(AxisTaskStep).check(Schema.isMaxLength(100)),
  status: Schema.Literals(["active", "paused"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("active")),
  ),
  revision: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
};

/** Legacy/execution tasks may omit purpose; absence is preserved on the wire. */
export const AxisTaskExecution = Schema.Struct({
  ...axisTaskFields,
  purpose: Schema.optionalKey(Schema.Literal("execution")),
});
export type AxisTaskExecution = typeof AxisTaskExecution.Type;

/** Onboarding tasks are explicitly typed and cannot omit their purpose. */
export const AxisOnboardingTask = Schema.Struct({
  ...axisTaskFields,
  purpose: Schema.Literal("onboarding"),
});
export type AxisOnboardingTask = typeof AxisOnboardingTask.Type;

/** The union keeps pre-purpose task JSON decodable while discriminating onboarding. */
export const AxisTaskExtension = Schema.Union([AxisTaskExecution, AxisOnboardingTask]);
export type AxisTaskExtension = typeof AxisTaskExtension.Type;

export const AxisTaskMutation = Schema.Struct({
  task: AxisTaskExtension,
  expectedRevision: NonNegativeInt,
  commandId: CommandId,
});
export type AxisTaskMutation = typeof AxisTaskMutation.Type;

export const AxisTaskLifecycleInput = Schema.Struct({
  scope: AxisContextProjectScope,
  threadId: ThreadId,
  taskId: AxisTaskId,
  expectedRevision: NonNegativeInt,
  commandId: CommandId,
});
export type AxisTaskLifecycleInput = typeof AxisTaskLifecycleInput.Type;

export class AxisTaskValidationError extends Schema.TaggedErrorClass<AxisTaskValidationError>()(
  "AxisTaskValidationError",
  { message: Schema.String },
) {}

export class AxisTaskPersistenceError extends Schema.TaggedErrorClass<AxisTaskPersistenceError>()(
  "AxisTaskPersistenceError",
  { operation: Schema.String },
) {}

export class AxisTaskConflictError extends Schema.TaggedErrorClass<AxisTaskConflictError>()(
  "AxisTaskConflictError",
  { taskId: Schema.String },
) {}

export class AxisTaskCommandConflictError extends Schema.TaggedErrorClass<AxisTaskCommandConflictError>()(
  "AxisTaskCommandConflictError",
  { commandId: Schema.String },
) {}

export const AxisTaskStoreError = Schema.Union([
  AxisTaskPersistenceError,
  AxisTaskConflictError,
  AxisTaskCommandConflictError,
  AxisTaskValidationError,
]);
export type AxisTaskStoreError = typeof AxisTaskStoreError.Type;

export const AxisSkillPort = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  description: TrimmedNonEmptyString.check(Schema.isMaxLength(1_000)),
  required: Schema.Boolean,
});
export type AxisSkillPort = typeof AxisSkillPort.Type;

export const AxisSkillDefinition = Schema.Struct({
  id: AxisSkillId,
  version: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  description: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
  inputs: Schema.Array(AxisSkillPort).check(Schema.isMaxLength(100)),
  outputs: Schema.Array(AxisSkillPort).check(Schema.isMaxLength(100)),
  requiredCapabilities: Schema.Array(AxisCapabilityId).check(Schema.isMaxLength(100)),
});
export type AxisSkillDefinition = typeof AxisSkillDefinition.Type;
