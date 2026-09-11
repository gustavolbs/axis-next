// @effect-diagnostics nodeBuiltinImport:off - intake digest dedupes retried intake per command.
import * as NodeCrypto from "node:crypto";

import {
  AxisContextId,
  AxisContextProjectScope,
  AxisTaskAcceptanceCriterion,
  AxisTaskExtension,
  AxisTaskId,
  AxisTaskStepId,
  AxisTaskStep,
  AxisWorkHubSourceId,
  CommandId,
  EnvironmentId,
  ThreadId,
  type AxisWorkHubCachedItem,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { AxisTaskStore } from "./AxisTaskStore.ts";
import { AxisProjectScope } from "../projects/AxisProjectScope.ts";
import { AxisWorkHubCacheStore } from "../workHub/AxisWorkHubCacheStore.ts";

const TITLE_MAX = 240;
const CRITERION_MAX = 2_000;
const ITEM_NATIVE_ID_MAX = 256;
const FINGERPRINT_MAX = 128;
const SKILL_ID_MAX = 128;
const STEP_ID_MAX = 128;

export const AxisTaskIntakeSourceKind = Schema.Literals(["local-text", "work-hub-item"]);
export type AxisTaskIntakeSourceKind = typeof AxisTaskIntakeSourceKind.Type;

const TrimmedTitle = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isTrimmed(),
  Schema.isMaxLength(TITLE_MAX),
);
const TrimmedFingerprint = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isTrimmed(),
  Schema.isMaxLength(FINGERPRINT_MAX),
);

export const AxisTaskIntakeLocalSource = Schema.Struct({
  kind: Schema.Literal("local-text"),
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
});
export type AxisTaskIntakeLocalSource = typeof AxisTaskIntakeLocalSource.Type;

export const AxisTaskIntakeWorkHubSource = Schema.Struct({
  kind: Schema.Literal("work-hub-item"),
  sourceId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  nativeId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(ITEM_NATIVE_ID_MAX)),
});
export type AxisTaskIntakeWorkHubSource = typeof AxisTaskIntakeWorkHubSource.Type;

export const AxisTaskIntakeSource = Schema.Union([
  AxisTaskIntakeLocalSource,
  AxisTaskIntakeWorkHubSource,
]);
export type AxisTaskIntakeSource = typeof AxisTaskIntakeSource.Type;

export interface AxisTaskIntakeRequest {
  readonly scope: AxisContextProjectScope;
  readonly threadId: ThreadId;
  readonly commandId: CommandId;
  readonly source: AxisTaskIntakeSource;
  readonly title: string;
  readonly acceptanceCriteria: ReadonlyArray<{
    readonly id: string;
    readonly text: string;
  }>;
  readonly workflowVersion: string;
  readonly steps: ReadonlyArray<{
    readonly id: string;
    readonly skillId: string;
  }>;
}

export const AxisTaskIntakeErrorReason = Schema.Literals([
  "invalid_input",
  "scope_denied",
  "ambiguous_mapping",
  "thread_not_found",
  "thread_project_mismatch",
  "duplicate_command",
  "persistence_failed",
]);
export type AxisTaskIntakeErrorReason = typeof AxisTaskIntakeErrorReason.Type;

export class AxisTaskIntakeError extends Schema.TaggedErrorClass<AxisTaskIntakeError>()(
  "AxisTaskIntakeError",
  { reason: AxisTaskIntakeErrorReason, message: Schema.String },
) {}

export interface AxisTaskIntakeResult {
  readonly task: AxisTaskExtension;
  readonly source: AxisTaskIntakeSource;
  readonly fingerprint: string;
  readonly workHubItem: AxisWorkHubCachedItem | null;
}

export class AxisTaskIntakeService extends Context.Service<
  AxisTaskIntakeService,
  {
    readonly intake: (
      caller: { readonly environmentId: EnvironmentId; readonly contextId: AxisContextId },
      request: AxisTaskIntakeRequest,
    ) => Effect.Effect<AxisTaskIntakeResult, AxisTaskIntakeError>;
  }
>()("t3/axis/tasks/AxisTaskIntake/AxisTaskIntakeService") {}

const fingerprintFor = (input: {
  scope: AxisContextProjectScope;
  threadId: ThreadId;
  source: AxisTaskIntakeSource;
  title: string;
  criteria: ReadonlyArray<{ id: string; text: string }>;
  workflowVersion: string;
  steps: ReadonlyArray<{ id: string; skillId: string }>;
}) =>
  `sha256:${NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify({
        scope: input.scope,
        threadId: input.threadId,
        source: input.source,
        title: input.title,
        criteria: input.criteria,
        workflowVersion: input.workflowVersion,
        steps: input.steps,
      }),
      "utf8",
    )
    .digest("hex")}`;

const deriveSource = (
  source: AxisTaskIntakeSource,
  workHubItem: AxisWorkHubCachedItem | null,
): AxisTaskExtension["source"] => {
  if (source.kind === "local-text") {
    return {
      kind: "local",
      label: source.label,
    };
  }
  if (workHubItem === null) return undefined;
  if (workHubItem.kind === "assigned-work-item") {
    const nativeId = workHubItem.nativeId;
    const deepLink = workHubItem.deepLink;
    if (deepLink !== null && deepLink.includes("atlassian.net")) {
      const match = /\/browse\/([A-Z][A-Z0-9_]+-\d+)/u.exec(deepLink);
      if (match !== null) {
        return {
          kind: "jira",
          issueKey: match[1] ?? nativeId,
          ...(deepLink !== null ? { url: deepLink } : {}),
        };
      }
    }
    if (deepLink !== null && deepLink.includes("trello.com")) {
      return {
        kind: "trello",
        cardId: nativeId,
        ...(deepLink !== null ? { url: deepLink } : {}),
      };
    }
    return undefined;
  }
  return undefined;
};

export const make = Effect.gen(function* () {
  const projectScope = yield* AxisProjectScope;
  const taskStore = yield* AxisTaskStore;
  const cache = yield* AxisWorkHubCacheStore;

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
            new AxisTaskIntakeError({
              reason: "scope_denied",
              message: "Caller cannot intake a task into this project.",
            }),
        ),
      );

  const intake: AxisTaskIntakeService["Service"]["intake"] = (caller, raw) =>
    Effect.gen(function* () {
      const request = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          scope: AxisContextProjectScope,
          threadId: ThreadId,
          commandId: CommandId,
          source: AxisTaskIntakeSource,
          title: TrimmedTitle,
          acceptanceCriteria: Schema.Array(
            Schema.Struct({
              id: AxisTaskStepId,
              text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(CRITERION_MAX)),
            }),
          ).check(Schema.isMaxLength(200)),
          workflowVersion: Schema.String.check(
            Schema.isMinLength(1),
            Schema.isMaxLength(SKILL_ID_MAX),
          ),
          steps: Schema.Array(
            Schema.Struct({
              id: AxisTaskStepId,
              skillId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(SKILL_ID_MAX)),
            }),
          ).check(Schema.isMaxLength(100)),
        }),
      )(raw).pipe(
        Effect.mapError(
          () =>
            new AxisTaskIntakeError({
              reason: "invalid_input",
              message: "Task intake input did not validate.",
            }),
        ),
      );
      yield* authorize(caller, request.scope, "write");

      let workHubItem: AxisWorkHubCachedItem | null = null;
      if (request.source.kind === "work-hub-item") {
        const snapshot = yield* cache.get(AxisWorkHubSourceId.make(request.source.sourceId)).pipe(
          Effect.mapError(
            () =>
              new AxisTaskIntakeError({
                reason: "persistence_failed",
                message: "Cannot read Work Hub snapshot for the intake source.",
              }),
          ),
        );
        if (snapshot === null) {
          return yield* new AxisTaskIntakeError({
            reason: "ambiguous_mapping",
            message:
              "Work Hub snapshot is not available. Refresh the source before retrying intake.",
          });
        }
        const nativeId = request.source.kind === "work-hub-item" ? request.source.nativeId : "";
        const matches = snapshot.items.filter((item) => item.nativeId === nativeId);
        if (matches.length === 0) {
          return yield* new AxisTaskIntakeError({
            reason: "ambiguous_mapping",
            message: "Work Hub item is not present in the cached snapshot.",
          });
        }
        if (matches.length > 1) {
          return yield* new AxisTaskIntakeError({
            reason: "ambiguous_mapping",
            message:
              "Multiple cached items share this native id; deduplicate the snapshot before intake.",
          });
        }
        workHubItem = matches[0] ?? null;
      }

      const fingerprint = fingerprintFor({
        scope: request.scope,
        threadId: request.threadId,
        source: request.source,
        title: request.title,
        criteria: request.acceptanceCriteria,
        workflowVersion: request.workflowVersion,
        steps: request.steps,
      });
      const now = DateTime.formatIso(yield* DateTime.now);
      const taskId = AxisTaskId.make(`task-${fingerprint.slice(7, 23)}`);
      const criteria = request.acceptanceCriteria.map((criterion) =>
        Schema.decodeUnknownSync(AxisTaskAcceptanceCriterion)({
          id: AxisTaskStepId.make(criterion.id),
          text: criterion.text,
        }),
      );
      const steps: AxisTaskStep[] = request.steps.map((step) =>
        Schema.decodeUnknownSync(AxisTaskStep)({
          id: AxisTaskStepId.make(step.id),
          skillId: Schema.decodeSync(Schema.String.pipe(Schema.brand("AxisSkillId")))(
            step.skillId,
          ) as unknown as AxisTaskStep["skillId"],
          status: "not-executed" as const,
          turnId: null,
          commandId: null,
          reason: null,
          startedAt: null,
          finishedAt: null,
        }),
      );
      const taskSource = deriveSource(request.source, workHubItem);
      const task = yield* Schema.decodeUnknownEffect(AxisTaskExtension)({
        id: taskId,
        scope: request.scope,
        threadId: request.threadId,
        ...(taskSource === undefined ? {} : { source: taskSource }),
        title: request.title,
        acceptanceCriteria: criteria,
        workflowVersion: request.workflowVersion,
        steps,
        status: "active",
        revision: 0,
        createdAt: now,
        updatedAt: now,
      }).pipe(
        Effect.mapError(
          () =>
            new AxisTaskIntakeError({
              reason: "invalid_input",
              message: "Constructed task did not validate.",
            }),
        ),
      );
      const created = yield* taskStore.create(task, request.commandId).pipe(
        Effect.mapError((cause) => {
          if (cause._tag === "AxisTaskValidationError") {
            return new AxisTaskIntakeError({
              reason: "thread_project_mismatch",
              message: cause.message,
            });
          }
          if (cause._tag === "AxisTaskConflictError") {
            return new AxisTaskIntakeError({
              reason: "thread_not_found",
              message: cause.message,
            });
          }
          if (cause._tag === "AxisTaskCommandConflictError") {
            return new AxisTaskIntakeError({
              reason: "duplicate_command",
              message: cause.message,
            });
          }
          return new AxisTaskIntakeError({
            reason: "persistence_failed",
            message: cause.message,
          });
        }),
      );
      return {
        task: created,
        source: request.source,
        fingerprint,
        workHubItem,
      } satisfies AxisTaskIntakeResult;
    });

  return { intake } satisfies AxisTaskIntakeService["Service"];
});

export const layer = Layer.effect(AxisTaskIntakeService, make);
