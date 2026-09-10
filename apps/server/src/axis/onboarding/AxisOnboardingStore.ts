// @effect-diagnostics nodeBuiltinImport:off - command digests are deterministic persistence keys.
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  AxisOnboardingCancelInput,
  AxisOnboardingRetryInput,
  AxisOnboardingRun,
  AxisOnboardingStartInput,
  type AxisOnboardingRun as AxisOnboardingRunType,
} from "../../../../../packages/contracts/src/axisOnboarding.ts";
import {
  axisProjectScopeKey,
  type AxisContextProjectScope as AxisContextProjectScopeType,
} from "../../../../../packages/contracts/src/axisProjectProfile.ts";

type RunRow = {
  readonly runId: unknown;
  readonly contextId: unknown;
  readonly scopeKey: unknown;
  readonly environmentId: unknown;
  readonly projectId: unknown;
  readonly threadId: unknown;
  readonly turnId: unknown;
  readonly status: unknown;
  readonly runJson: unknown;
};

type CommandRow = {
  readonly runId: unknown;
  readonly requestDigest: unknown;
  readonly action: unknown;
};

export class AxisOnboardingPersistenceError extends Schema.TaggedErrorClass<AxisOnboardingPersistenceError>()(
  "AxisOnboardingPersistenceError",
  { operation: Schema.String },
) {}

export class AxisOnboardingConflictError extends Schema.TaggedErrorClass<AxisOnboardingConflictError>()(
  "AxisOnboardingConflictError",
  { runId: Schema.String },
) {}

export class AxisOnboardingCommandConflictError extends Schema.TaggedErrorClass<AxisOnboardingCommandConflictError>()(
  "AxisOnboardingCommandConflictError",
  { commandId: Schema.String },
) {}

export class AxisOnboardingValidationError extends Schema.TaggedErrorClass<AxisOnboardingValidationError>()(
  "AxisOnboardingValidationError",
  { message: Schema.String },
) {}

export type AxisOnboardingStoreError =
  | AxisOnboardingPersistenceError
  | AxisOnboardingConflictError
  | AxisOnboardingCommandConflictError
  | AxisOnboardingValidationError;

const decodeRunJson = Schema.decodeUnknownEffect(Schema.fromJsonString(AxisOnboardingRun));
const encodeRunJson = Schema.encodeEffect(Schema.fromJsonString(AxisOnboardingRun));
const decodeRun = Schema.decodeUnknownEffect(AxisOnboardingRun);
const decodeStartInput = Schema.decodeUnknownEffect(AxisOnboardingStartInput);
const decodeCancelInput = Schema.decodeUnknownEffect(AxisOnboardingCancelInput);
const decodeRetryInput = Schema.decodeUnknownEffect(AxisOnboardingRetryInput);

const persistenceError = (operation: string) => new AxisOnboardingPersistenceError({ operation });

// context_id is stored separately; keep the project key free of SQLite's NUL handling.
const scopeKey = (scope: AxisContextProjectScopeType) => axisProjectScopeKey(scope.project);

const digest = (value: unknown) =>
  `sha256:${NodeCrypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;

const invalidRun = (message: string) => Effect.fail(new AxisOnboardingValidationError({ message }));

export class AxisOnboardingStore extends Context.Service<
  AxisOnboardingStore,
  {
    readonly list: (
      scope: AxisContextProjectScopeType,
    ) => Effect.Effect<ReadonlyArray<AxisOnboardingRunType>, AxisOnboardingPersistenceError>;
    readonly get: (
      scope: AxisContextProjectScopeType,
      runId: AxisOnboardingRunType["id"],
    ) => Effect.Effect<Option.Option<AxisOnboardingRunType>, AxisOnboardingPersistenceError>;
    readonly save: (
      run: AxisOnboardingRunType,
    ) => Effect.Effect<void, AxisOnboardingPersistenceError | AxisOnboardingValidationError>;
    readonly start: (
      input: typeof AxisOnboardingStartInput.Type | AxisOnboardingRunType,
    ) => Effect.Effect<AxisOnboardingRunType, AxisOnboardingStoreError>;
    readonly cancel: (
      scope: AxisContextProjectScopeType,
      input: typeof AxisOnboardingCancelInput.Type,
    ) => Effect.Effect<AxisOnboardingRunType, AxisOnboardingStoreError>;
    readonly retry: (
      scope: AxisContextProjectScopeType,
      input: typeof AxisOnboardingRetryInput.Type,
    ) => Effect.Effect<AxisOnboardingRunType, AxisOnboardingStoreError>;
  }
>()("t3/axis/onboarding/AxisOnboardingStore") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const decodeRow = (
    row: RunRow,
  ): Effect.Effect<AxisOnboardingRunType, AxisOnboardingPersistenceError> =>
    decodeRunJson(row.runJson).pipe(
      Effect.mapError(() => persistenceError("decode onboarding run")),
      Effect.flatMap((run) =>
        typeof row.runId === "string" &&
        typeof row.contextId === "string" &&
        typeof row.scopeKey === "string" &&
        typeof row.environmentId === "string" &&
        typeof row.projectId === "string" &&
        typeof row.threadId === "string" &&
        typeof row.turnId === "string" &&
        typeof row.status === "string" &&
        run.id === row.runId &&
        run.scope.contextId === row.contextId &&
        scopeKey(run.scope) === row.scopeKey &&
        run.scope.project.environmentId === row.environmentId &&
        run.scope.project.projectId === row.projectId &&
        run.execution.threadId === row.threadId &&
        run.execution.turnId === row.turnId &&
        run.status === row.status
          ? Effect.succeed(run)
          : Effect.fail(persistenceError("validate onboarding run row")),
      ),
    );

  const readRows = (scope: AxisContextProjectScopeType, runId?: AxisOnboardingRunType["id"]) =>
    sql<RunRow>`
      SELECT
        run_id AS "runId",
        context_id AS "contextId",
        scope_key AS "scopeKey",
        environment_id AS "environmentId",
        project_id AS "projectId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        status,
        run_json AS "runJson"
      FROM axis_onboarding_runs
      WHERE context_id = ${scope.contextId}
        AND scope_key = ${scopeKey(scope)}
        ${runId === undefined ? sql`` : sql`AND run_id = ${runId}`}
      ORDER BY started_at DESC, run_id
    `;

  const read = (
    scope: AxisContextProjectScopeType,
    runId: AxisOnboardingRunType["id"],
  ): Effect.Effect<Option.Option<AxisOnboardingRunType>, AxisOnboardingPersistenceError> =>
    readRows(scope, runId).pipe(
      Effect.mapError(() => persistenceError("read onboarding run")),
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.succeed(Option.none())
          : decodeRow(rows[0]).pipe(Effect.map(Option.some)),
      ),
    );

  const list: AxisOnboardingStore["Service"]["list"] = (scope) =>
    readRows(scope).pipe(
      Effect.mapError(() => persistenceError("list onboarding runs")),
      Effect.flatMap((rows) => Effect.forEach(rows, decodeRow, { concurrency: 8 })),
    );

  const get: AxisOnboardingStore["Service"]["get"] = read;

  const encode = (run: AxisOnboardingRunType) =>
    encodeRunJson(run).pipe(Effect.mapError(() => persistenceError("encode onboarding run")));

  const saveEncoded = (run: AxisOnboardingRunType, runJson: string, updatedAt: string) =>
    sql`
      INSERT INTO axis_onboarding_runs (
        run_id, context_id, environment_id, project_id, scope_key,
        thread_id, turn_id, status, run_json, started_at, finished_at, updated_at
      ) VALUES (
        ${run.id}, ${run.scope.contextId}, ${run.scope.project.environmentId},
        ${run.scope.project.projectId}, ${scopeKey(run.scope)}, ${run.execution.threadId},
        ${run.execution.turnId}, ${run.status}, ${runJson}, ${run.startedAt},
        ${run.finishedAt}, ${updatedAt}
      )
      ON CONFLICT (context_id, scope_key, run_id) DO UPDATE SET
        environment_id = excluded.environment_id,
        project_id = excluded.project_id,
        thread_id = excluded.thread_id,
        turn_id = excluded.turn_id,
        status = excluded.status,
        run_json = excluded.run_json,
        started_at = excluded.started_at,
        finished_at = excluded.finished_at,
        updated_at = excluded.updated_at
    `;

  const save: AxisOnboardingStore["Service"]["save"] = (run) =>
    encode(run).pipe(
      Effect.flatMap((runJson) =>
        sql.withTransaction(saveEncoded(run, runJson, DateTime.formatIso(DateTime.nowUnsafe()))),
      ),
      Effect.asVoid,
      Effect.mapError((error) =>
        error._tag === "AxisOnboardingPersistenceError"
          ? error
          : persistenceError("save onboarding run"),
      ),
    );

  const readCommand = (scope: AxisContextProjectScopeType, commandId: string) =>
    sql<CommandRow>`
      SELECT run_id AS "runId", request_digest AS "requestDigest", action
      FROM axis_onboarding_commands
      WHERE context_id = ${scope.contextId}
        AND scope_key = ${scopeKey(scope)}
        AND command_id = ${commandId}
    `.pipe(Effect.mapError(() => persistenceError("read onboarding command")));

  const validateStart = (input: typeof AxisOnboardingStartInput.Type | AxisOnboardingRunType) =>
    decodeStartInput(input).pipe(
      Effect.map((decoded) => decoded.run),
      Effect.catch(() =>
        decodeRun(input).pipe(
          Effect.mapError(
            () => new AxisOnboardingValidationError({ message: "Invalid onboarding start input." }),
          ),
        ),
      ),
      Effect.flatMap((run) =>
        run.status === "running"
          ? Effect.succeed(run)
          : invalidRun("An onboarding run must be running when it starts."),
      ),
    );

  const start: AxisOnboardingStore["Service"]["start"] = (input) =>
    validateStart(input).pipe(
      Effect.flatMap((run) =>
        encode(run).pipe(
          Effect.flatMap((runJson) =>
            sql.withTransaction(
              Effect.gen(function* () {
                const commandId = run.execution.commandId;
                const requestDigest = digest({ action: "start", run });
                const previous = yield* readCommand(run.scope, commandId);
                if (previous[0] !== undefined) {
                  if (
                    previous[0].runId !== run.id ||
                    previous[0].requestDigest !== requestDigest ||
                    previous[0].action !== "start"
                  ) {
                    return yield* new AxisOnboardingCommandConflictError({ commandId });
                  }
                  const existing = yield* read(run.scope, run.id);
                  return Option.isSome(existing)
                    ? existing.value
                    : yield* new AxisOnboardingPersistenceError({
                        operation: "read idempotent onboarding start",
                      });
                }
                const existing = yield* read(run.scope, run.id);
                if (Option.isSome(existing)) {
                  return yield* new AxisOnboardingConflictError({ runId: run.id });
                }
                const now = DateTime.formatIso(DateTime.nowUnsafe());
                yield* saveEncoded(run, runJson, now);
                yield* sql`
                  INSERT INTO axis_onboarding_commands
                    (context_id, scope_key, run_id, command_id, action, request_digest, created_at)
                  VALUES
                    (${run.scope.contextId}, ${scopeKey(run.scope)}, ${run.id}, ${commandId},
                     'start', ${requestDigest}, ${now})
                `;
                return run;
              }),
            ),
          ),
        ),
      ),
      Effect.catchTag("SqlError", () => Effect.fail(persistenceError("start onboarding run"))),
    );

  const transition = (
    scope: AxisContextProjectScopeType,
    runId: AxisOnboardingRunType["id"],
    commandId: string,
    action: "cancel" | "retry",
    reason?: string,
  ): Effect.Effect<AxisOnboardingRunType, AxisOnboardingStoreError> =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const requestDigest = digest({
            action,
            runId,
            scope,
            ...(reason === undefined ? {} : { reason }),
          });
          const previous = yield* readCommand(scope, commandId);
          if (previous[0] !== undefined) {
            if (
              previous[0].runId !== runId ||
              previous[0].requestDigest !== requestDigest ||
              previous[0].action !== action
            ) {
              return yield* new AxisOnboardingCommandConflictError({ commandId });
            }
            const existing = yield* read(scope, runId);
            return Option.isSome(existing)
              ? existing.value
              : yield* new AxisOnboardingPersistenceError({
                  operation: "read idempotent onboarding command",
                });
          }

          const current = yield* read(scope, runId);
          if (Option.isNone(current)) return yield* new AxisOnboardingConflictError({ runId });
          if (action === "cancel" && current.value.status !== "running") {
            return yield* new AxisOnboardingConflictError({ runId });
          }
          if (action === "retry" && !["cancelled", "failed"].includes(current.value.status)) {
            return yield* new AxisOnboardingConflictError({ runId });
          }

          const next: AxisOnboardingRunType =
            action === "cancel"
              ? {
                  ...current.value,
                  status: "cancelled",
                  error: null,
                  finishedAt: DateTime.formatIso(DateTime.nowUnsafe()),
                }
              : { ...current.value, status: "running", error: null, finishedAt: null };
          const runJson = yield* encode(next);
          const now = DateTime.formatIso(DateTime.nowUnsafe());
          yield* saveEncoded(next, runJson, now);
          yield* sql`
          INSERT INTO axis_onboarding_commands
            (context_id, scope_key, run_id, command_id, action, request_digest, created_at)
          VALUES
            (${scope.contextId}, ${scopeKey(scope)}, ${runId}, ${commandId}, ${action}, ${requestDigest}, ${now})
        `;
          return next;
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", () =>
          Effect.fail(persistenceError(`${action} onboarding run`)),
        ),
      );

  const cancel: AxisOnboardingStore["Service"]["cancel"] = (scope, input) =>
    decodeCancelInput(input).pipe(
      Effect.mapError(
        () => new AxisOnboardingValidationError({ message: "Invalid onboarding cancel input." }),
      ),
      Effect.flatMap((decoded) =>
        transition(scope, decoded.runId, decoded.commandId, "cancel", decoded.reason),
      ),
    );

  const retry: AxisOnboardingStore["Service"]["retry"] = (scope, input) =>
    decodeRetryInput(input).pipe(
      Effect.mapError(
        () => new AxisOnboardingValidationError({ message: "Invalid onboarding retry input." }),
      ),
      Effect.flatMap((decoded) => transition(scope, decoded.runId, decoded.commandId, "retry")),
    );

  return { list, get, save, start, cancel, retry } satisfies AxisOnboardingStore["Service"];
});

export const layer = Layer.effect(AxisOnboardingStore, make);
