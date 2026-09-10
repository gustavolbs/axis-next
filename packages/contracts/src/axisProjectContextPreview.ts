import * as Schema from "effect/Schema";
import { AxisProviderInstanceLocator } from "./axisContext.ts";
import { AxisLearningVersionId } from "./axisLearning.ts";
import { AxisContextProjectScope, AxisProjectRule } from "./axisProjectProfile.ts";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const AxisProjectContextPreviewInput = Schema.Struct({
  scope: AxisContextProjectScope,
  provider: AxisProviderInstanceLocator,
  model: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  step: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  paths: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(2_048))).check(
    Schema.isMaxLength(100),
  ),
});
export type AxisProjectContextPreviewInput = typeof AxisProjectContextPreviewInput.Type;

export const AxisProjectContextPreviewResult = Schema.Struct({
  scope: AxisContextProjectScope,
  provider: AxisProviderInstanceLocator,
  model: Schema.optional(Schema.String),
  step: Schema.String,
  profileRevision: NonNegativeInt,
  rules: Schema.Array(AxisProjectRule),
  sources: Schema.Array(Schema.String),
  learningVersionIds: Schema.Array(AxisLearningVersionId),
  conflicts: Schema.Array(Schema.String),
  digest: Schema.String,
});
export type AxisProjectContextPreviewResult = typeof AxisProjectContextPreviewResult.Type;

export class AxisProjectContextPreviewError extends Schema.TaggedErrorClass<AxisProjectContextPreviewError>()(
  "AxisProjectContextPreviewError",
  { message: Schema.String },
) {}
