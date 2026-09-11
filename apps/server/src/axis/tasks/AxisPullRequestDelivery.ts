// @effect-diagnostics nodeBuiltinImport:off - delivery digest ties publication to the live diff.
import * as NodeCrypto from "node:crypto";
import {
  AxisContextId,
  AxisContextProjectScope,
  CommandId,
  EnvironmentId,
  type GitPreparePullRequestThreadInput,
  type GitPreparePullRequestThreadResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { AxisProjectScope } from "../projects/AxisProjectScope.ts";
import type { AxisPullRequestPlan } from "./AxisPullRequestPlan.ts";

const PUBLICATION_URL_MAX = 2_048;
const PUBLICATION_BRANCH_MAX = 256;
const NOTE_MAX = 2_000;
const DIGEST_MAX = 128;

export const AxisPullRequestDeliveryState = Schema.Literals([
  "submitted",
  "reconciled",
  "rejected",
  "unknown",
]);
export type AxisPullRequestDeliveryState = typeof AxisPullRequestDeliveryState.Type;

const TrimmedUrl = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(PUBLICATION_URL_MAX),
);
const TrimmedBranch = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(PUBLICATION_BRANCH_MAX),
);
const TrimmedNote = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(NOTE_MAX));
const TrimmedDigest = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(DIGEST_MAX));

export const AxisPullRequestPublication = Schema.Struct({
  scope: AxisContextProjectScope,
  commandId: CommandId,
  planDigest: TrimmedDigest,
  state: AxisPullRequestDeliveryState,
  url: Schema.NullOr(TrimmedUrl),
  baseBranch: Schema.NullOr(TrimmedBranch),
  headBranch: Schema.NullOr(TrimmedBranch),
  worktreePath: Schema.NullOr(Schema.String),
  isOnPullRequestHead: Schema.NullOr(Schema.Boolean),
  note: Schema.NullOr(TrimmedNote),
  deliveredAt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
});
export type AxisPullRequestPublication = typeof AxisPullRequestPublication.Type;

export const AxisPullRequestDeliveryErrorReason = Schema.Literals([
  "invalid_input",
  "plan_mismatch",
  "scope_denied",
  "publish_failed",
  "reconcile_failed",
  "head_mismatch",
]);
export type AxisPullRequestDeliveryErrorReason = typeof AxisPullRequestDeliveryErrorReason.Type;

export class AxisPullRequestDeliveryError extends Schema.TaggedErrorClass<AxisPullRequestDeliveryError>()(
  "AxisPullRequestDeliveryError",
  { reason: AxisPullRequestDeliveryErrorReason, message: Schema.String },
) {}

export interface AxisPullRequestDeliveryInput {
  readonly plan: AxisPullRequestPlan;
  readonly cwd: string;
  readonly planDigest: string;
  readonly currentDiffDigest: string;
  readonly authorizationNote?: string;
}

export class AxisPullRequestDeliveryService extends Context.Service<
  AxisPullRequestDeliveryService,
  {
    readonly deliver: (
      caller: { readonly environmentId: string; readonly contextId: string },
      input: AxisPullRequestDeliveryInput,
    ) => Effect.Effect<AxisPullRequestPublication, AxisPullRequestDeliveryError>;
  }
>()("t3/axis/tasks/AxisPullRequestDelivery/AxisPullRequestDeliveryService") {}

const threadIdFor = (commandId: CommandId) =>
  Schema.decodeSync(Schema.String.pipe(Schema.brand("ThreadId")))(
    `axis-workflow-publish:${commandId}`,
  ) as unknown as GitPreparePullRequestThreadInput["threadId"];

const digestFor = (input: {
  readonly commandId: CommandId;
  readonly currentDiffDigest: string;
  readonly source: string;
  readonly destination: string;
  readonly branch: string;
}) =>
  `sha256:${NodeCrypto.createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex")}`;

export const make = Effect.gen(function* () {
  const git = yield* GitWorkflowService;
  const projectScope = yield* AxisProjectScope;
  const publications = new Map<string, AxisPullRequestPublication>();

  const authorize = (
    caller: { readonly environmentId: EnvironmentId; readonly contextId: AxisContextId },
    target: AxisContextProjectScope,
    operation: "read" | "write",
  ) =>
    projectScope
      .resolveProject({
        caller: { environmentId: caller.environmentId, contextId: caller.contextId },
        scope: target,
        operation,
      })
      .pipe(
        Effect.mapError(
          () =>
            new AxisPullRequestDeliveryError({
              reason: "scope_denied",
              message: "Caller cannot publish for this project.",
            }),
        ),
      );

  const resolveExisting = (commandId: CommandId, planDigest: string) =>
    Effect.gen(function* () {
      const existing = publications.get(commandId);
      if (existing !== undefined && existing.planDigest === planDigest) {
        return existing;
      }
      return yield* new AxisPullRequestDeliveryError({
        reason: "plan_mismatch",
        message:
          "A previous delivery for this command exists with a different digest; reconcile explicitly.",
      });
    });

  const deliver: AxisPullRequestDeliveryService["Service"]["deliver"] = (caller, raw) =>
    Effect.gen(function* () {
      const input = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          plan: Schema.Unknown,
          cwd: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(PUBLICATION_URL_MAX)),
          planDigest: TrimmedDigest,
          currentDiffDigest: TrimmedDigest,
          authorizationNote: Schema.optionalKey(TrimmedNote),
        }),
      )(raw).pipe(
        Effect.mapError(
          () =>
            new AxisPullRequestDeliveryError({
              reason: "invalid_input",
              message: "Pull request delivery input did not validate.",
            }),
        ),
      );
      const plan = input.plan as AxisPullRequestPlan;
      const authorizedCaller = {
        environmentId: EnvironmentId.make(caller.environmentId),
        contextId: AxisContextId.make(caller.contextId),
      };
      yield* authorize(authorizedCaller, plan.scope, "write");
      const expectedDigest = digestFor({
        commandId: plan.commandId,
        currentDiffDigest: input.currentDiffDigest,
        source: plan.source,
        destination: plan.destination,
        branch: plan.branch,
      });
      if (input.planDigest !== plan.diffDigest || expectedDigest !== plan.diffDigest) {
        return yield* new AxisPullRequestDeliveryError({
          reason: "plan_mismatch",
          message: "Plan digest does not match the current diff digest.",
        });
      }
      const previous = yield* resolveExisting(plan.commandId, plan.diffDigest).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (previous !== null && previous.state === "submitted" && previous.url !== null) {
        // The earlier submit may have succeeded; reconfirm by reading the PR.
        return previous;
      }
      const result = yield* git
        .preparePullRequestThread({
          cwd: input.cwd,
          reference: `axis:${plan.commandId}`,
          mode: "worktree",
          threadId: threadIdFor(plan.commandId),
        } satisfies GitPreparePullRequestThreadInput)
        .pipe(
          Effect.mapError(
            (cause) =>
              new AxisPullRequestDeliveryError({
                reason: "publish_failed",
                message: `Could not prepare the pull request thread: ${(cause as { message?: string }).message ?? (cause as { _tag?: string })._tag ?? "unknown"}.`,
              }),
          ),
        );
      if (!result.isOnPullRequestHead) {
        return yield* new AxisPullRequestDeliveryError({
          reason: "head_mismatch",
          message:
            "The pull request head could not be checked out; reconcile manually before reissuing.",
        });
      }
      const deliveredAt = DateTime.formatIso(yield* DateTime.now);
      const publication = yield* Schema.decodeUnknownEffect(AxisPullRequestPublication)({
        scope: plan.scope,
        commandId: plan.commandId,
        planDigest: plan.diffDigest,
        state: "submitted" as const,
        url: result.pullRequest.url,
        baseBranch: result.pullRequest.baseBranch,
        headBranch: result.pullRequest.headBranch,
        worktreePath: result.worktreePath ?? null,
        isOnPullRequestHead: result.isOnPullRequestHead,
        note: input.authorizationNote ?? null,
        deliveredAt,
      }).pipe(
        Effect.mapError(
          () =>
            new AxisPullRequestDeliveryError({
              reason: "publish_failed",
              message: "Publication payload did not validate.",
            }),
        ),
      );
      publications.set(plan.commandId, publication);
      return publication;
    });

  return { deliver } satisfies AxisPullRequestDeliveryService["Service"];
});

export const layer = Layer.effect(AxisPullRequestDeliveryService, make);
