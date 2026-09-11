import { assert, it } from "@effect/vitest";
import {
  AxisContextId,
  AxisTaskSource,
  CommandId,
  EnvironmentId,
  ProviderInstanceId,
  type AxisProviderInstanceLocator,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  AxisJiraAdapterService,
  AxisJiraConfirmRequiredError,
  AxisJiraNativeIssueKey,
  AxisJiraSourceMismatchError,
  AxisJiraTransportError,
  makeAxisJiraAdapterNoop,
  noopAxisJiraAdapterLayer,
  noteForTransition,
  withJiraConfirmation,
} from "./AxisJiraAdapter.ts";

const provider: AxisProviderInstanceLocator = {
  environmentId: EnvironmentId.make("env"),
  instanceId: ProviderInstanceId.make("codex"),
};
const identity = {
  environmentId: EnvironmentId.make("env"),
  contextId: AxisContextId.make("company"),
  provider,
};

const jiraSource = (overrides: Partial<AxisTaskSource & { kind: "jira" }> = {}) => ({
  kind: "jira" as const,
  issueKey: overrides.issueKey ?? "AX-42",
  ...(overrides.url === undefined ? {} : { url: overrides.url }),
});

const noopLayer = Layer.succeed(AxisJiraAdapterService, makeAxisJiraAdapterNoop());

it.layer(noopLayer)("AxisJiraAdapter noop", (it) => {
  it.effect("posts a stub comment and returns a stable identifier", () =>
    Effect.gen(function* () {
      const service = yield* AxisJiraAdapterService;
      const result = yield* service.postComment(identity, {
        issueKey: AxisJiraNativeIssueKey.make("AX-42"),
        body: "Updated by Axis workflow.",
        placement: "internal",
      });
      assert.equal(result.commentId.startsWith("jira-comment-stub:AX-42:"), true);
    }),
  );

  it.effect("transitions an issue without any external call", () =>
    Effect.gen(function* () {
      const service = yield* AxisJiraAdapterService;
      const result = yield* service.transitionIssue(identity, {
        issueKey: AxisJiraNativeIssueKey.make("AX-42"),
        transition: "in-review",
        note: noteForTransition("in-review"),
      });
      assert.equal(result.state, "in-review");
      assert.equal(result.issueKey, "AX-42");
    }),
  );
});

it.layer(noopLayer)("AxisJiraAdapter confirmation", (it) => {
  it.effect("rejects a context mismatch with AxisJiraConfirmRequiredError", () =>
    Effect.gen(function* () {
      const inner = makeAxisJiraAdapterNoop();
      const confirmed = withJiraConfirmation(
        jiraSource(),
        { ...identity, contextId: AxisContextId.make("other-context") },
        CommandId.make("command-jira"),
        inner,
      );
      const error = yield* Effect.flip(
        confirmed.postComment(identity, {
          issueKey: AxisJiraNativeIssueKey.make("AX-42"),
          body: "x",
          placement: "internal",
        }),
      );
      assert.equal(error._tag, "AxisJiraConfirmRequiredError");
    }),
  );

  it.effect("rejects a task without a Jira source", () =>
    Effect.gen(function* () {
      const inner = makeAxisJiraAdapterNoop();
      const confirmed = withJiraConfirmation(
        { kind: "local", label: "manual" } as unknown as AxisTaskSource,
        identity,
        CommandId.make("command-jira"),
        inner,
      );
      const error = yield* Effect.flip(
        confirmed.postComment(identity, {
          issueKey: AxisJiraNativeIssueKey.make("AX-42"),
          body: "x",
          placement: "internal",
        }),
      );
      assert.equal(error._tag, "AxisJiraSourceMismatchError");
    }),
  );

  it.effect("rejects a Jira source URL with embedded credentials", () =>
    Effect.gen(function* () {
      const inner = makeAxisJiraAdapterNoop();
      const confirmed = withJiraConfirmation(
        jiraSource({ url: "https://user:secret@company.atlassian.net/browse/AX-42" }),
        identity,
        CommandId.make("command-jira"),
        inner,
      );
      const error = yield* Effect.flip(
        confirmed.transitionIssue(identity, {
          issueKey: AxisJiraNativeIssueKey.make("AX-42"),
          transition: "done",
        }),
      );
      assert.equal(error._tag, "AxisJiraTransportError");
    }),
  );

  it.effect("forwards to the inner adapter once confirmation passes", () =>
    Effect.gen(function* () {
      const inner = makeAxisJiraAdapterNoop();
      const confirmed = withJiraConfirmation(
        jiraSource({ url: "https://company.atlassian.net/browse/AX-42" }),
        identity,
        CommandId.make("command-jira"),
        inner,
      );
      const result = yield* confirmed.postComment(identity, {
        issueKey: AxisJiraNativeIssueKey.make("AX-42"),
        body: "all good",
        placement: "external",
      });
      assert.equal(result.commentId.length > 0, true);
    }),
  );
});

it.layer(noopAxisJiraAdapterLayer)("AxisJiraAdapter default layer", (it) => {
  it.effect("provides a default noop implementation", () =>
    Effect.gen(function* () {
      const service = yield* AxisJiraAdapterService;
      const result = yield* service.transitionIssue(identity, {
        issueKey: AxisJiraNativeIssueKey.make("AX-42"),
        transition: "done",
      });
      assert.equal(result.state, "done");
    }),
  );
});
