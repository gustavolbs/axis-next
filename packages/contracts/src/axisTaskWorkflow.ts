/** Durable workflow operations accept scoped identities; task content is server-owned. */
import * as Schema from "effect/Schema";
import { AxisContextProjectScope } from "./axisProjectProfile.ts";
import { AxisSkillId, AxisTaskExtension, AxisTaskId, AxisTaskStepId } from "./axisTask.ts";
import { CommandId, MessageId, NonNegativeInt, ThreadId, TurnId } from "./baseSchemas.ts";
import { ModelSelection } from "./orchestration.ts";

export const AxisWorkflowLookup = Schema.Struct({
  scope: AxisContextProjectScope,
  threadId: ThreadId,
  taskId: AxisTaskId,
  stepId: AxisTaskStepId,
  commandId: CommandId,
});
export type AxisWorkflowLookup = typeof AxisWorkflowLookup.Type;
export const AxisWorkflowAdmission = Schema.Struct({
  ...AxisWorkflowLookup.fields,
  expectedRevision: NonNegativeInt,
  modelSelection: ModelSelection,
});
export type AxisWorkflowAdmission = typeof AxisWorkflowAdmission.Type;
export const AxisWorkflowRetryAdmission = Schema.Struct({
  ...AxisWorkflowAdmission.fields,
  previousCommandId: CommandId,
});
export type AxisWorkflowRetryAdmission = typeof AxisWorkflowRetryAdmission.Type;
export const AxisWorkflowCancel = Schema.Struct({
  ...AxisWorkflowLookup.fields,
  expectedRevision: NonNegativeInt,
});
export type AxisWorkflowCancel = typeof AxisWorkflowCancel.Type;

export const AxisWorkflowArtifact = Schema.Struct({
  kind: Schema.Literal("document"),
  skillId: AxisSkillId,
  execution: Schema.Struct({ threadId: ThreadId, turnId: TurnId, commandId: CommandId }),
  messageId: MessageId,
  requestDigest: Schema.String,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64_000)),
});
export type AxisWorkflowArtifact = typeof AxisWorkflowArtifact.Type;
export const AxisWorkflowState = Schema.Struct({
  taskId: AxisTaskId,
  stepId: AxisTaskStepId,
  status: Schema.Literals([
    "not-executed",
    "accepted",
    "running",
    "waiting-input",
    "interrupted",
    "failed",
    "completed",
    "validation-pending",
    "blocked",
    "unknown",
    "not-applicable",
  ]),
  execution: Schema.Struct({
    threadId: ThreadId,
    turnId: Schema.NullOr(TurnId),
    commandId: CommandId,
  }),
  artifact: Schema.NullOr(AxisWorkflowArtifact),
  reason: Schema.NullOr(Schema.String),
});
export type AxisWorkflowState = typeof AxisWorkflowState.Type;
export const AxisWorkflowSnapshot = Schema.Struct({
  task: AxisTaskExtension,
  state: AxisWorkflowState,
});
export type AxisWorkflowSnapshot = typeof AxisWorkflowSnapshot.Type;

export class AxisTaskWorkflowServiceError extends Schema.TaggedErrorClass<AxisTaskWorkflowServiceError>()(
  "AxisTaskWorkflowServiceError",
  {
    reason: Schema.Literals([
      "invalid_input",
      "not_found",
      "conflict",
      "scope_denied",
      "observation_failed",
      "cancel_unconfirmed",
    ]),
    message: Schema.String,
  },
) {}
