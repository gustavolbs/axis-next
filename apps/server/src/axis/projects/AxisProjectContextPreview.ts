import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { AxisProjectScopeCaller } from "./AxisProjectScope.ts";
import {
  AxisEffectiveContext,
  type AxisEffectiveContextInput,
  type AxisEffectiveContextResult,
  AxisEffectiveContextValidationError,
} from "./AxisEffectiveContext.ts";

/**
 * Preview selection is deliberately separate from the effective result. Rules
 * and source contents are read from the server-owned profile/catalog/learning
 * stores through AxisEffectiveContext; callers cannot submit them here.
 */
export type AxisProjectContextPreviewInput = Omit<AxisEffectiveContextInput, "caller"> & {
  readonly caller: AxisProjectScopeCaller;
};

export type AxisProjectContextPreviewResult = Pick<
  AxisEffectiveContextResult,
  | "scope"
  | "provider"
  | "model"
  | "step"
  | "profileRevision"
  | "rules"
  | "learningVersionIds"
  | "conflicts"
  | "digest"
> & {
  /** Stable source references, never source contents. */
  readonly sources: ReadonlyArray<string>;
};

export class AxisProjectContextPreview extends Context.Service<
  AxisProjectContextPreview,
  {
    readonly resolve: (
      input: AxisProjectContextPreviewInput,
    ) => Effect.Effect<AxisProjectContextPreviewResult, AxisEffectiveContextValidationError>;
  }
>()("t3/axis/projects/AxisProjectContextPreview") {}

export const make = Effect.gen(function* () {
  const effectiveContext = yield* AxisEffectiveContext;

  const resolve: AxisProjectContextPreview["Service"]["resolve"] = (input) =>
    effectiveContext.resolve(input).pipe(
      Effect.map((result) => ({
        scope: result.scope,
        provider: result.provider,
        ...(result.model === undefined ? {} : { model: result.model }),
        step: result.step,
        profileRevision: result.profileRevision,
        rules: result.rules,
        sources: result.sourceRefs,
        learningVersionIds: result.learningVersionIds,
        conflicts: result.conflicts,
        digest: result.digest,
      })),
    );

  return { resolve } satisfies AxisProjectContextPreview["Service"];
});

/**
 * AxisEffectiveContext currently authorizes every resolution as `execute`.
 * Keeping preview on this layer intentionally preserves that authorization
 * until the resolver exposes a distinct read/preview operation.
 */
export const layer = Layer.effect(AxisProjectContextPreview, make);
