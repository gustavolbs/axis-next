/** Testable adapter contracts for tracker write paths.
 * Real implementations bind to MCP/SDK credentials owned by the environment.
 * These interfaces intentionally have no network calls and no live side
 * effects; the bindings are expected to be supplied per environment. */
import {
  AxisContextId,
  AxisTaskSource,
  CommandId,
  EnvironmentId,
  type AxisProviderInstanceLocator,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const CONFIRMATION_NOTE_MAX = 2_000;
const MAPPING_KEY_MAX = 256;

export const AxisJiraTransition = Schema.Literals([
  "to-do",
  "in-progress",
  "in-review",
  "done",
  "blocked",
]);
export type AxisJiraTransition = typeof AxisJiraTransition.Type;

export const AxisJiraCommentPlacement = Schema.Literals(["internal", "external"]);
export type AxisJiraCommentPlacement = typeof AxisJiraCommentPlacement.Type;

export const AxisJiraNativeIssueKey = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isTrimmed(),
  Schema.isPattern(/^[A-Z][A-Z0-9_]+-\d+$/u),
  Schema.isMaxLength(MAPPING_KEY_MAX),
);
export type AxisJiraNativeIssueKey = typeof AxisJiraNativeIssueKey.Type;

export interface AxisJiraBindingIdentity {
  readonly environmentId: EnvironmentId;
  readonly contextId: AxisContextId;
  readonly provider: AxisProviderInstanceLocator;
}

export interface AxisJiraIssueCommentInput {
  readonly issueKey: AxisJiraNativeIssueKey;
  readonly body: string;
  readonly placement: AxisJiraCommentPlacement;
}

export interface AxisJiraIssueTransitionInput {
  readonly issueKey: AxisJiraNativeIssueKey;
  readonly transition: AxisJiraTransition;
  readonly note?: string;
}

export const AxisJiraConfirmRequiredError = Schema.TaggedErrorClass<{
  readonly _tag: "AxisJiraConfirmRequiredError";
  readonly message: string;
}>()("AxisJiraConfirmRequiredError", { message: Schema.String });

export const AxisJiraSourceMismatchError = Schema.TaggedErrorClass<{
  readonly _tag: "AxisJiraSourceMismatchError";
  readonly message: string;
}>()("AxisJiraSourceMismatchError", { message: Schema.String });

export const AxisJiraTransportError = Schema.TaggedErrorClass<{
  readonly _tag: "AxisJiraTransportError";
  readonly message: string;
}>()("AxisJiraTransportError", { message: Schema.String });

export const AxisJiraError = Schema.Union([
  AxisJiraConfirmRequiredError,
  AxisJiraSourceMismatchError,
  AxisJiraTransportError,
]);
export type AxisJiraError = typeof AxisJiraError.Type;

export interface AxisJiraAdapter {
  readonly postComment: (
    identity: AxisJiraBindingIdentity,
    input: AxisJiraIssueCommentInput,
  ) => Effect.Effect<{ readonly commentId: string }, AxisJiraError>;
  readonly transitionIssue: (
    identity: AxisJiraBindingIdentity,
    input: AxisJiraIssueTransitionInput,
  ) => Effect.Effect<
    { readonly issueKey: string; readonly state: AxisJiraTransition },
    AxisJiraError
  >;
}

export class AxisJiraAdapterService extends Context.Service<AxisJiraAdapter>()(
  "t3/axis/tasks/AxisJiraAdapter",
) {}

const assertJiraSource = (
  source: AxisTaskSource["Type"] | undefined,
  identity: AxisJiraBindingIdentity,
): Effect.Effect<AxisJiraNativeIssueKey, AxisJiraError> => {
  if (source === undefined || source.kind !== "jira") {
    return Effect.fail(
      new AxisJiraSourceMismatchError({
        message: "Task source does not identify a Jira issue.",
      }),
    );
  }
  if (source.url !== undefined) {
    try {
      const url = new URL(source.url);
      if (url.username.length > 0 || url.password.length > 0) {
        return Effect.fail(
          new AxisJiraTransportError({
            message: "Jira source URL must not embed credentials.",
          }),
        );
      }
    } catch {
      return Effect.fail(
        new AxisJiraTransportError({
          message: "Jira source URL is not parseable.",
        }),
      );
    }
  }
  return Effect.succeed(Schema.decodeUnknownSync(AxisJiraNativeIssueKey)(source.issueKey));
};

export const makeAxisJiraAdapterNoop = (): AxisJiraAdapter => ({
  postComment: (_identity, input) =>
    Effect.succeed({
      commentId: `jira-comment-stub:${input.issueKey}:${Math.random().toString(36).slice(2, 10)}`,
    }),
  transitionIssue: (_identity, input) =>
    Effect.succeed({
      issueKey: input.issueKey,
      state: input.transition,
    }),
});

/** Wraps an arbitrary adapter to enforce task-sourced confirmation and
 * scope alignment. The adapter itself never owns transport; the binding is
 * supplied at composition time. */
export const withJiraConfirmation = (
  source: AxisTaskSource["Type"] | undefined,
  identity: AxisJiraBindingIdentity,
  commandId: CommandId,
  inner: AxisJiraAdapter,
): AxisJiraAdapter => ({
  postComment: (id, input) =>
    Effect.gen(function* () {
      if (id.contextId !== identity.contextId) {
        return yield* Effect.fail(
          new AxisJiraConfirmRequiredError({
            message: "Jira binding context does not match the task context.",
          }),
        );
      }
      yield* assertJiraSource(source, identity);
      yield* Effect.annotateCurrentSpan({
        "axis.command.id": commandId,
        "axis.jira.issue": input.issueKey,
      });
      return yield* inner.postComment(id, input);
    }),
  transitionIssue: (id, input) =>
    Effect.gen(function* () {
      if (id.contextId !== identity.contextId) {
        return yield* Effect.fail(
          new AxisJiraConfirmRequiredError({
            message: "Jira binding context does not match the task context.",
          }),
        );
      }
      yield* assertJiraSource(source, identity);
      yield* Effect.annotateCurrentSpan({
        "axis.command.id": commandId,
        "axis.jira.issue": input.issueKey,
        "axis.jira.transition": input.transition,
      });
      return yield* inner.transitionIssue(id, input);
    }),
});

export const noopAxisJiraAdapterLayer = Layer.succeed(
  AxisJiraAdapterService,
  makeAxisJiraAdapterNoop(),
);

export const noteForTransition = (transition: AxisJiraTransition): string => {
  switch (transition) {
    case "to-do":
      return "Returned to backlog by Axis workflow.";
    case "in-progress":
      return "Moved to in-progress by Axis workflow.";
    case "in-review":
      return "Ready for review by Axis workflow.";
    case "done":
      return "Closed by Axis workflow after merge confirmation.";
    case "blocked":
      return "Blocked by Axis workflow; requires attention.";
  }
};

export const noteLengthCap = CONFIRMATION_NOTE_MAX;
