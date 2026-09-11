import {
  type AxisLearningEngineCancellation,
  type AxisLearningEngineError,
  AxisLearningEngineCancelledError,
  AxisLearningEngineDeadlineExceededError,
  type AxisLearningEngineHandler,
  AxisLearningEngineOutput,
  AxisLearningEngineOutputError,
  AxisLearningEngineRequest,
  type AxisLearningEngineRunResult,
  type AxisLearningEngineStatus,
  type AxisLearningEngineUnavailable,
  AxisLearningEngineValidationError,
  type AxisLearningEngineAvailability,
  axisLearningEngineScopeEquals,
} from "../../../../../packages/contracts/src/axisLearningEngine.ts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export interface AxisLearningEngineExecutor {
  readonly status: AxisLearningEngineStatus;
  readonly run: AxisLearningEngineHandler;
}

export class AxisLearningEngine extends Context.Service<
  AxisLearningEngine,
  {
    readonly status: AxisLearningEngineStatus;
    readonly run: (
      request: unknown,
      cancellation?: AxisLearningEngineCancellation,
    ) => Effect.Effect<AxisLearningEngineRunResult, AxisLearningEngineError>;
  }
>()("t3/axis/learning/AxisLearningEngine") {}

const decodeRequest = Schema.decodeUnknownEffect(AxisLearningEngineRequest);
const decodeOutput = Schema.decodeUnknownEffect(AxisLearningEngineOutput);

const unavailable = (status: AxisLearningEngineStatus): AxisLearningEngineUnavailable => ({
  status: "unavailable",
  availability: status.availability as "absent" | "offline",
  message:
    status.message ??
    (status.availability === "offline"
      ? "The Axis learning engine is offline."
      : "No Axis learning engine is configured."),
});

const cancelled = (signal: AbortSignal) =>
  Effect.callback<never, AxisLearningEngineCancelledError>((resume) => {
    const finish = () =>
      resume(
        Effect.fail(
          new AxisLearningEngineCancelledError({
            message: "The learning engine run was cancelled.",
          }),
        ),
      );
    if (signal.aborted) {
      finish();
      return;
    }
    signal.addEventListener("abort", finish, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", finish));
  });

const validateOutput = (
  request: AxisLearningEngineRequest,
  raw: unknown,
): Effect.Effect<AxisLearningEngineOutput, AxisLearningEngineOutputError> =>
  decodeOutput(raw).pipe(
    Effect.mapError(
      () =>
        new AxisLearningEngineOutputError({
          message: "The learning engine returned invalid output.",
        }),
    ),
    Effect.flatMap(
      (output): Effect.Effect<AxisLearningEngineOutput, AxisLearningEngineOutputError> => {
        if (output.status === "no-change") return Effect.succeed(output);
        const evidenceIds = new Set(request.evidenceRefs.map((reference) => reference.id));
        for (const proposal of output.proposals) {
          if (
            proposal.contextId !== request.contextId ||
            !axisLearningEngineScopeEquals(proposal.scope, request.scope)
          ) {
            return Effect.fail(
              new AxisLearningEngineOutputError({
                message: "The learning engine returned a proposal outside the requested scope.",
              }),
            );
          }
          if (
            new Set(proposal.evidenceIds).size !== proposal.evidenceIds.length ||
            proposal.evidenceIds.some((id) => !evidenceIds.has(id))
          ) {
            return Effect.fail(
              new AxisLearningEngineOutputError({
                message: "The learning engine returned an unknown or duplicate evidence reference.",
              }),
            );
          }
        }
        return Effect.succeed(output);
      },
    ),
  );

export const make = (executor?: AxisLearningEngineExecutor) => {
  const status =
    executor === undefined
      ? ({
          availability: "absent" as AxisLearningEngineAvailability,
          message: "No Axis learning engine is configured.",
        } satisfies AxisLearningEngineStatus)
      : executor.status;

  const run = Effect.fn("AxisLearningEngine.run")(function* (
    rawRequest: unknown,
    cancellation: AxisLearningEngineCancellation = {},
  ) {
    const request = yield* decodeRequest(rawRequest).pipe(
      Effect.mapError(
        () =>
          new AxisLearningEngineValidationError({
            message: "The learning engine request is invalid.",
          }),
      ),
    );
    if (status.availability !== "available" || executor === undefined) return unavailable(status);

    const controller = new AbortController();
    const execution = executor.run(request, { signal: controller.signal }).pipe(
      Effect.timeout(Duration.millis(request.deadlineMs)),
      Effect.catchTag("TimeoutError", () =>
        Effect.fail(
          new AxisLearningEngineDeadlineExceededError({ deadlineMs: request.deadlineMs }),
        ),
      ),
      Effect.ensuring(Effect.sync(() => controller.abort())),
    );
    const bounded =
      cancellation.signal === undefined
        ? execution
        : execution.pipe(Effect.raceFirst(cancelled(cancellation.signal)));
    return yield* validateOutput(request, yield* bounded);
  });

  return Effect.succeed({ status, run } satisfies AxisLearningEngine["Service"]);
};

export const layer = (executor?: AxisLearningEngineExecutor) =>
  Layer.effect(AxisLearningEngine, make(executor));
