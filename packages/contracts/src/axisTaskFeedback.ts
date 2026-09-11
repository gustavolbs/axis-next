import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString, TurnId } from "./baseSchemas.ts";
import { AxisWorkflowLookup } from "./axisTaskWorkflow.ts";

/** Client input identifies an admitted execution; the server derives all feedback content. */
export const AxisTaskFeedbackRequest = Schema.Struct({
  ...AxisWorkflowLookup.fields,
  /** Optional assertion only. The evidence turn always comes from persistence. */
  expectedTurnId: Schema.optionalKey(TurnId),
});
export type AxisTaskFeedbackRequest = typeof AxisTaskFeedbackRequest.Type;

export const AxisTaskFeedbackErrorReason = Schema.Literals([
  "invalid_input",
  "scope_denied",
  "not_found",
  "mismatch",
  "not_terminal",
  "observation_failed",
  "persistence_failed",
]);
export type AxisTaskFeedbackErrorReason = typeof AxisTaskFeedbackErrorReason.Type;

const AxisTaskFeedbackErrorMessage = TrimmedNonEmptyString.check(Schema.isMaxLength(512));

export class AxisTaskFeedbackError extends Schema.TaggedErrorClass<AxisTaskFeedbackError>()(
  "AxisTaskFeedbackError",
  {
    reason: AxisTaskFeedbackErrorReason,
    message: AxisTaskFeedbackErrorMessage,
  },
) {}
