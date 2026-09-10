import {
  AxisContextProjectScope,
  CommandId,
  MessageId,
  ModelSelection,
  RuntimeMode,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { AxisProjectScope } from "../projects/AxisProjectScope.ts";

export const EXECUTION_TIMEOUT_MS = 30 * 60_000;
export const CANCELLATION_TIMEOUT_MS = 30_000;
export const MAX_EXECUTION_TEXT_LENGTH = 64_000;
const Text = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_EXECUTION_TEXT_LENGTH),
);
const Input = Schema.Struct({
  scope: AxisContextProjectScope,
  threadId: ThreadId,
  commandId: CommandId,
  modelSelection: ModelSelection,
  prompt: Text,
  runtimeMode: Schema.optional(RuntimeMode),
});
const Output = Schema.fromJsonString(Schema.Struct({ text: Text }));
const FailureActivity = Schema.Struct({ requestId: Schema.optional(Schema.String) });
const decodeInput = Schema.decodeUnknownEffect(Input);
const decodeOutput = Schema.decodeUnknownEffect(Output);
const decodeFailureActivity = Schema.decodeUnknownEffect(FailureActivity);

export class AxisTaskExecutionError extends Schema.TaggedErrorClass<AxisTaskExecutionError>()(
  "AxisTaskExecutionError",
  {
    reason: Schema.Literals([
      "invalid_input",
      "scope_denied",
      "ambiguous_replay",
      "dispatch_failed",
      "provider_failed",
      "interrupted",
      "invalid_output",
      "timeout",
      "cancel_failed",
      "callback_failed",
      "observation_failed",
    ]),
    message: Schema.String,
  },
) {}

export interface AxisTaskExecutionReference {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly commandId: CommandId;
}
export interface AxisTaskExecutionInput<E = never, R = never> extends Schema.Schema.Type<
  typeof Input
> {
  readonly onTurnStarted?: (execution: AxisTaskExecutionReference) => Effect.Effect<void, E, R>;
}
export interface AxisTaskExecutionResult {
  readonly execution: AxisTaskExecutionReference;
  readonly text: string;
}

const failure = (reason: AxisTaskExecutionError["reason"], message: string) =>
  new AxisTaskExecutionError({ reason, message });

/** One fresh, dedicated thread per attempt. Existing history is never resumed here.
 * The caller owns authorization and persistence of the attempt reference. The scope
 * resolver additionally checks current project/provider access before dispatch.
 */
export const execute = Effect.fn("AxisTaskExecution.execute")(function* <E = never, R = never>(
  raw: AxisTaskExecutionInput<E, R>,
) {
  const input = yield* decodeInput(raw).pipe(
    Effect.mapError(() => failure("invalid_input", "Invalid execution input or oversized prompt.")),
  );
  const engine = yield* OrchestrationEngineService;
  const turns = yield* ProjectionTurnRepository;
  const scope = yield* AxisProjectScope;
  const crypto = yield* Crypto.Crypto;
  const newCommandId = crypto.randomUUIDv4.pipe(
    Effect.map(CommandId.make),
    Effect.mapError(() => failure("dispatch_failed", "Cannot allocate a command identifier.")),
  );
  yield* scope
    .resolve({
      caller: {
        environmentId: input.scope.project.environmentId,
        contextId: input.scope.contextId,
      },
      operation: "execute",
      scope: input.scope,
      provider: {
        environmentId: input.scope.project.environmentId,
        instanceId: input.modelSelection.instanceId,
      },
    })
    .pipe(
      Effect.mapError(() =>
        failure("scope_denied", "Project or provider access is no longer valid."),
      ),
    );

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const events = yield* engine.subscribeDomainEvents;
      const head = yield* engine.latestSequence;
      const history = yield* engine
        .readThreadEvents({
          threadId: input.threadId,
          fromSequenceExclusive: 0,
          toSequenceInclusive: head,
          limit: 1,
        })
        .pipe(
          Stream.runHead,
          Effect.mapError(() => failure("observation_failed", "Cannot verify thread history.")),
        );
      if (Option.isSome(history)) {
        return yield* failure(
          "ambiguous_replay",
          "This attempt already has thread history. Use a new thread and command for an explicit retry.",
        );
      }
      const messageId = MessageId.make(`axis-execution:${input.commandId}`);
      const done = yield* Deferred.make<AxisTaskExecutionResult, AxisTaskExecutionError>();
      const ended = yield* Deferred.make<void, AxisTaskExecutionError>();
      let execution: AxisTaskExecutionReference | undefined;
      let terminal = false;
      let succeeded = false;
      let sawRunning = false;
      let dispatched = false;
      let lastSequence = head;
      let resultText: string | undefined;
      const messages = new Map<MessageId, string>();
      let bufferedCharacters = 0;
      const observe = Effect.fn("AxisTaskExecution.observe")(function* (event: OrchestrationEvent) {
        if (
          event.aggregateKind !== "thread" ||
          event.aggregateId !== input.threadId ||
          event.sequence <= lastSequence
        )
          return;
        lastSequence = event.sequence;
        if (event.type === "thread.turn-start-requested" && event.commandId !== input.commandId) {
          return yield* failure(
            "ambiguous_replay",
            "Another command used this attempt's dedicated thread.",
          );
        }
        if (event.type === "thread.activity-appended") {
          const activity = event.payload.activity;
          if (activity.kind === "provider.turn.interrupt.failed") {
            yield* Deferred.fail(
              ended,
              failure("cancel_failed", "The provider did not confirm interruption."),
            );
          }
          if (activity.kind === "provider.turn.start.failed") {
            const payload = yield* decodeFailureActivity(activity.payload).pipe(Effect.option);
            if (Option.isSome(payload) && payload.value.requestId === messageId) {
              terminal = true;
              yield* Deferred.succeed(ended, undefined);
              return yield* failure("provider_failed", "The provider rejected this turn start.");
            }
          }
        }
        if (event.type === "thread.session-set" || event.type === "thread.message-sent") {
          if (execution === undefined) {
            const rows = yield* turns
              .listByThreadId({ threadId: input.threadId })
              .pipe(
                Effect.mapError(() =>
                  failure("observation_failed", "Cannot correlate the execution turn."),
                ),
              );
            const matching = rows.filter(
              (row) => row.pendingMessageId === messageId && row.turnId !== null,
            );
            if (matching.length > 1)
              return yield* failure("ambiguous_replay", "Multiple turns match this attempt.");
            const row = matching[0];
            if (row?.turnId != null) {
              execution = {
                threadId: input.threadId,
                turnId: row.turnId,
                commandId: input.commandId,
              };
              if (raw.onTurnStarted !== undefined)
                yield* raw
                  .onTurnStarted(execution)
                  .pipe(
                    Effect.mapError(() =>
                      failure("callback_failed", "Could not persist the execution reference."),
                    ),
                  );
            }
          }
        }
        if (event.type === "thread.session-set") {
          const session = event.payload.session;
          if (
            session.providerInstanceId !== undefined &&
            session.providerInstanceId !== input.modelSelection.instanceId
          ) {
            return yield* failure(
              "ambiguous_replay",
              "Another provider took over the dedicated thread.",
            );
          }
          if (
            execution !== undefined &&
            session.activeTurnId !== null &&
            session.activeTurnId !== execution.turnId
          ) {
            return yield* failure("ambiguous_replay", "A different turn replaced this attempt.");
          }
          if (
            session.status === "error" ||
            session.status === "interrupted" ||
            session.status === "stopped"
          ) {
            terminal = true;
            yield* Deferred.succeed(ended, undefined);
            return yield* failure(
              session.status === "interrupted" ? "interrupted" : "provider_failed",
              session.lastError ?? "The provider stopped this attempt.",
            );
          }
          if (
            execution !== undefined &&
            session.status === "running" &&
            session.activeTurnId === execution.turnId
          )
            sawRunning = true;
          if (sawRunning && session.status === "ready" && session.activeTurnId === null) {
            terminal = true;
            succeeded = true;
            yield* Deferred.succeed(ended, undefined);
          }
        }
        if (
          event.type === "thread.message-sent" &&
          execution !== undefined &&
          event.payload.turnId === execution.turnId &&
          event.payload.role === "assistant"
        ) {
          bufferedCharacters += event.payload.text.length;
          if (bufferedCharacters > MAX_EXECUTION_TEXT_LENGTH * 6 + 32 || messages.size > 100) {
            return yield* failure(
              "invalid_output",
              "The provider response exceeded the execution output limit.",
            );
          }
          const text = (messages.get(event.payload.messageId) ?? "") + event.payload.text;
          messages.set(event.payload.messageId, text);
          if (event.payload.streaming) return;
          messages.delete(event.payload.messageId);
          bufferedCharacters -= text.length;
          // Only the explicitly requested result envelope is output. Commentary
          // can finish before the turn, and the final message can arrive after it.
          const parsed = yield* decodeOutput(text).pipe(Effect.option);
          if (Option.isSome(parsed)) resultText = parsed.value.text;
        }
        if (succeeded && execution !== undefined && resultText !== undefined) {
          yield* Deferred.succeed(done, { execution, text: resultText });
        }
      });
      yield* events.pipe(
        Stream.runForEach((event) =>
          observe(event).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : Deferred.fail(
                    done,
                    Cause.findErrorOption(cause).pipe(
                      Option.getOrElse(() =>
                        failure("observation_failed", "Execution event observation failed."),
                      ),
                    ),
                  ).pipe(Effect.asVoid),
            ),
          ),
        ),
        Effect.forkScoped,
      );

      const cancel = Effect.fn("AxisTaskExecution.cancel")(function* () {
        if (!dispatched || terminal) return;
        yield* engine
          .dispatch({
            type: "thread.turn.interrupt",
            commandId: yield* newCommandId,
            threadId: input.threadId,
            ...(execution === undefined ? {} : { turnId: execution.turnId }),
            createdAt: DateTime.formatIso(yield* DateTime.now),
          })
          .pipe(
            Effect.mapError(() =>
              failure(
                "cancel_failed",
                "Interrupt dispatch failed; the provider effect is unknown.",
              ),
            ),
          );
        yield* Deferred.await(ended);
      });
      const cancelBounded = cancel().pipe(
        Effect.interruptible,
        Effect.timeoutOrElse({
          duration: CANCELLATION_TIMEOUT_MS,
          orElse: () =>
            Effect.fail(
              failure(
                "cancel_failed",
                "Interrupt was not confirmed within 30 seconds; the provider effect is unknown.",
              ),
            ),
        }),
      );
      const run = Effect.gen(function* () {
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        yield* engine
          .dispatch({
            type: "thread.create",
            commandId: yield* newCommandId,
            threadId: input.threadId,
            projectId: input.scope.project.projectId,
            title: "Axis task execution",
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode ?? "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt,
          })
          .pipe(
            Effect.mapError(() =>
              failure("dispatch_failed", "Could not create a fresh dedicated thread."),
            ),
          );
        // Cancellation must account for an enqueued command even if dispatch's
        // caller is interrupted before receiving its durable receipt.
        dispatched = true;
        yield* engine
          .dispatch({
            type: "thread.turn.start",
            commandId: input.commandId,
            threadId: input.threadId,
            message: {
              messageId,
              role: "user",
              attachments: [],
              text: `${input.prompt}\n\nReturn your final result as a single JSON object {"text":"your result"}. Use this envelope only for the final result, not progress updates. The text must be at most ${MAX_EXECUTION_TEXT_LENGTH} characters.`,
            },
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode ?? "approval-required",
            interactionMode: "default",
            createdAt,
          })
          .pipe(
            Effect.mapError(() =>
              failure(
                "dispatch_failed",
                "Turn dispatch failed; do not replay this attempt automatically.",
              ),
            ),
          );
        return yield* Deferred.await(done);
      }).pipe(
        Effect.timeoutOrElse({
          duration: EXECUTION_TIMEOUT_MS,
          orElse: () =>
            Effect.fail(
              failure(
                succeeded ? "invalid_output" : "timeout",
                succeeded
                  ? "The completed turn did not provide a valid bounded result envelope."
                  : "Execution exceeded 30 minutes; automatic replay is disabled.",
              ),
            ),
        }),
      );
      return yield* run.pipe(
        Effect.onExit((exit) => (Exit.isFailure(exit) ? cancelBounded : Effect.void)),
      );
    }),
  );
});

export class AxisTaskExecution extends Context.Service<
  AxisTaskExecution,
  {
    readonly execute: <E = never, R = never>(
      input: AxisTaskExecutionInput<E, R>,
    ) => Effect.Effect<AxisTaskExecutionResult, AxisTaskExecutionError, R>;
  }
>()("t3/axis/tasks/AxisTaskExecution") {}

export const layer = Layer.effect(
  AxisTaskExecution,
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const turns = yield* ProjectionTurnRepository;
    const scope = yield* AxisProjectScope;
    const crypto = yield* Crypto.Crypto;
    return {
      execute: <E = never, R = never>(input: AxisTaskExecutionInput<E, R>) =>
        execute(input).pipe(
          Effect.provideService(OrchestrationEngineService, engine),
          Effect.provideService(ProjectionTurnRepository, turns),
          Effect.provideService(AxisProjectScope, scope),
          Effect.provideService(Crypto.Crypto, crypto),
        ),
    } satisfies AxisTaskExecution["Service"];
  }),
);
