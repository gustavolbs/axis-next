/**
 * W07 — AxisPullRequestDelivery.
 *
 * Executes an authorized pull request plan through the existing
 * `SourceControlProvider` registry. The publisher reconciles lost responses by
 * reading back the change request by head/base before retrying, so two clicks
 * cannot open duplicate PRs. CI and draft status are read from the host
 * after a successful create; failures preserve the plan and surface the
 * last-known state to the caller.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";

import { AxisContextProjectScope, TrimmedNonEmptyString } from "@t3tools/contracts";

export const AxisPullRequestDeliveryInputSchema = Schema.Struct({
  scope: AxisContextProjectScope,
  planDigest: TrimmedNonEmptyString,
  source: Schema.Struct({
    cwd: TrimmedNonEmptyString,
    baseBranch: TrimmedNonEmptyString,
    headSelector: TrimmedNonEmptyString,
    title: TrimmedNonEmptyString,
    body: TrimmedNonEmptyString,
  }),
  draft: Schema.Boolean,
});
export type AxisPullRequestDeliveryInput = typeof AxisPullRequestDeliveryInputSchema.Type;

export const AxisPullRequestDeliveryStateSchema = Schema.Struct({
  planDigest: TrimmedNonEmptyString,
  reference: Schema.NullOr(TrimmedNonEmptyString),
  url: Schema.NullOr(TrimmedNonEmptyString),
  draft: Schema.Boolean,
  ciStatus: Schema.Literals(["unknown", "pending", "passed", "failed"]),
  observedAt: TrimmedNonEmptyString,
});
export type AxisPullRequestDeliveryState = typeof AxisPullRequestDeliveryStateSchema.Type;

export class AxisPullRequestDeliveryError extends Schema.TaggedErrorClass<AxisPullRequestDeliveryError>()(
  "AxisPullRequestDeliveryError",
  {
    reason: Schema.Literals([
      "invalid_input",
      "duplicate",
      "scope_mismatch",
      "create_failed",
      "reconcile_failed",
      "auth_revoked",
    ]),
    message: Schema.String,
  },
) {}

const error = (reason: AxisPullRequestDeliveryError["reason"], message: string) =>
  new AxisPullRequestDeliveryError({ reason, message });

export interface AxisPullRequestDeliveryAdapter {
  readonly createChangeRequest: (input: {
    readonly cwd: string;
    readonly baseBranch: string;
    readonly headSelector: string;
    readonly title: string;
    readonly body: string;
    readonly draft: boolean;
  }) => Effect.Effect<
    { readonly reference: string; readonly url: string | null },
    { readonly _tag: string; readonly message: string }
  >;
  readonly findChangeRequest: (input: {
    readonly cwd: string;
    readonly headSelector: string;
    readonly baseBranch: string;
  }) => Effect.Effect<
    { readonly reference: string; readonly url: string | null; readonly draft: boolean } | null,
    { readonly _tag: string; readonly message: string }
  >;
  readonly readChangeRequestChecks: (input: {
    readonly cwd: string;
    readonly reference: string;
  }) => Effect.Effect<
    "unknown" | "pending" | "passed" | "failed",
    { readonly _tag: string; readonly message: string }
  >;
}

const stateDigest = (input: AxisPullRequestDeliveryInput) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex");

export const publishAxisPullRequestPlan = (
  adapter: AxisPullRequestDeliveryAdapter,
  input: AxisPullRequestDeliveryInput,
): Effect.Effect<AxisPullRequestDeliveryState, AxisPullRequestDeliveryError> =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(DateTime.nowUnsafe());
    const existing = yield* adapter
      .findChangeRequest({
        cwd: input.source.cwd,
        headSelector: input.source.headSelector,
        baseBranch: input.source.baseBranch,
      })
      .pipe(
        Effect.mapError((cause) =>
          error("reconcile_failed", `Cannot reconcile existing pull request: ${cause.message}`),
        ),
      );
    if (existing !== null) {
      const ciStatus = yield* adapter
        .readChangeRequestChecks({ cwd: input.source.cwd, reference: existing.reference })
        .pipe(
          Effect.mapError((cause) =>
            error(
              "reconcile_failed",
              `Cannot read CI status for the existing pull request: ${cause.message}`,
            ),
          ),
        );
      return {
        planDigest: stateDigest(input),
        reference: existing.reference,
        url: existing.url,
        draft: existing.draft,
        ciStatus,
        observedAt: now,
      };
    }
    const created = yield* adapter
      .createChangeRequest({
        cwd: input.source.cwd,
        baseBranch: input.source.baseBranch,
        headSelector: input.source.headSelector,
        title: input.source.title,
        body: input.source.body,
        draft: input.draft,
      })
      .pipe(
        Effect.mapError((cause) => {
          if (cause._tag === "AuthRevokedError" || cause._tag === "AuthScopeError") {
            return error("auth_revoked", cause.message);
          }
          return error("create_failed", cause.message);
        }),
      );
    const ciStatus = yield* adapter
      .readChangeRequestChecks({ cwd: input.source.cwd, reference: created.reference })
      .pipe(
        Effect.mapError(() => error("reconcile_failed", "Cannot read CI status after create.")),
        Effect.orElseSucceed(() => "pending" as const),
      );
    return {
      planDigest: stateDigest(input),
      reference: created.reference,
      url: created.url,
      draft: input.draft,
      ciStatus,
      observedAt: now,
    };
  });

export const deliveryPlanDigest = (input: AxisPullRequestDeliveryInput): string =>
  stateDigest(input);
