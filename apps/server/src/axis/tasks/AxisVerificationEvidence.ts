import {
  AxisContextId,
  AxisContextProjectScope,
  AxisSkillId,
  AxisTaskStepId,
  CommandId,
  EnvironmentId,
  TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { AxisProjectScope } from "../projects/AxisProjectScope.ts";

const EXECUTION_TEXT_PREVIEW_MAX = 2_000;
const EVIDENCE_SUMMARY_MAX = 2_000;
const REASON_MAX = 2_000;
const FILE_PATH_MAX = 2_048;
const COMMAND_MAX = 4_096;
const EXIT_CODE_MIN = 0;
const EXIT_CODE_MAX = 65_535;

/** Captured outcome of a single verification action. The reporter never infers
 * "passed" from provider text; the executor must observe an actual exit code
 * or a not-applicable rationale before the reporter classifies the result. */
export const AxisVerificationKind = Schema.Literals([
  "command",
  "test-run",
  "build",
  "static-inspection",
  "manual-check",
]);
export type AxisVerificationKind = typeof AxisVerificationKind.Type;

export const AxisVerificationStatus = Schema.Literals([
  "passed",
  "failed",
  "not-applicable",
  "not-run",
]);
export type AxisVerificationStatus = typeof AxisVerificationStatus.Type;

export const AxisVerificationCoverage = Schema.Literals(["covered", "missing", "stale"]);
export type AxisVerificationCoverage = typeof AxisVerificationCoverage.Type;

const TrimmedReason = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isTrimmed(),
  Schema.isMaxLength(REASON_MAX),
);

const ExitCode = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(EXIT_CODE_MIN),
  Schema.isLessThanOrEqualTo(EXIT_CODE_MAX),
);

export const AxisVerificationCommand = Schema.Struct({
  command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(COMMAND_MAX)),
  cwd: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(FILE_PATH_MAX))),
  exitCode: ExitCode,
  durationMs: Schema.optionalKey(ExitCode),
  stdoutExcerpt: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(EXECUTION_TEXT_PREVIEW_MAX)),
  ),
  stderrExcerpt: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(EXECUTION_TEXT_PREVIEW_MAX)),
  ),
});
export type AxisVerificationCommand = typeof AxisVerificationCommand.Type;

export const AxisVerificationEvidence = Schema.Struct({
  scope: AxisContextProjectScope,
  stepId: AxisTaskStepId,
  skillId: AxisSkillId,
  commandId: CommandId,
  turnId: Schema.NullOr(TurnId),
  kind: AxisVerificationKind,
  status: AxisVerificationStatus,
  /** Stable identifier derived from inputs; review/stale logic keys on this. */
  fingerprint: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  summary: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isTrimmed(),
    Schema.isMaxLength(EVIDENCE_SUMMARY_MAX),
  ),
  reason: Schema.NullOr(TrimmedReason),
  command: Schema.NullOr(AxisVerificationCommand),
  coveredFiles: Schema.Array(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(FILE_PATH_MAX)),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  observedAt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
});
export type AxisVerificationEvidence = typeof AxisVerificationEvidence.Type;

export class AxisVerificationInputError extends Schema.TaggedErrorClass<AxisVerificationInputError>()(
  "AxisVerificationInputError",
  { message: Schema.String },
) {}

export class AxisVerificationScopeError extends Schema.TaggedErrorClass<AxisVerificationScopeError>()(
  "AxisVerificationScopeError",
  { message: Schema.String },
) {}

export const AxisVerificationStoreError = Schema.Union([
  AxisVerificationInputError,
  AxisVerificationScopeError,
]);
export type AxisVerificationStoreError = typeof AxisVerificationStoreError.Type;

const fingerprintFor = (input: {
  scope: AxisContextProjectScope;
  stepId: AxisTaskStepId;
  skillId: AxisSkillId;
  commandId: CommandId;
  kind: AxisVerificationKind;
  command: AxisVerificationCommand | null;
}) =>
  [
    input.scope.contextId,
    input.scope.project.environmentId,
    input.scope.project.projectId,
    input.stepId,
    input.skillId,
    input.commandId,
    input.kind,
    input.command === null
      ? "none"
      : `${input.command.command}|${input.command.exitCode}|${input.command.cwd ?? ""}`,
  ].join("::");

const validateCommand = (command: AxisVerificationCommand | null) => {
  if (command === null) return;
  const text = `${command.stdoutExcerpt ?? ""}${command.stderrExcerpt ?? ""}`.trim();
  if (text.length === 0) return;
  if (command.exitCode !== 0 && command.stderrExcerpt === undefined) return;
};

const classify = (command: AxisVerificationCommand | null): AxisVerificationStatus => {
  if (command === null) return "not-run";
  if (command.exitCode === 0) return "passed";
  return "failed";
};

const noteFor = (command: AxisVerificationCommand | null, status: AxisVerificationStatus) => {
  if (status === "not-applicable") return "Marked not-applicable for this step.";
  if (command === null) return "No observed command result is available yet.";
  if (status === "passed") return "Command exited with a zero status.";
  return `Command exited with status ${command.exitCode}.`;
};

export interface AxisVerificationRecordInput {
  readonly scope: AxisContextProjectScope;
  readonly stepId: AxisTaskStepId;
  readonly skillId: AxisSkillId;
  readonly commandId: CommandId;
  readonly turnId: TurnId | null;
  readonly kind: AxisVerificationKind;
  readonly summary: string;
  readonly reason?: string | null;
  readonly command: AxisVerificationCommand | null;
  readonly coveredFiles?: ReadonlyArray<string>;
  readonly observedAt: string;
}

export interface AxisVerificationReporter {
  readonly record: (
    caller: { readonly environmentId: EnvironmentId; readonly contextId: AxisContextId },
    input: AxisVerificationRecordInput,
  ) => Effect.Effect<AxisVerificationEvidence, AxisVerificationStoreError>;
  readonly markNotApplicable: (
    caller: { readonly environmentId: EnvironmentId; readonly contextId: AxisContextId },
    input: Omit<AxisVerificationRecordInput, "command" | "kind"> & {
      readonly kind?: AxisVerificationKind;
      readonly reason: string;
    },
  ) => Effect.Effect<AxisVerificationEvidence, AxisVerificationStoreError>;
  readonly coverage: (
    scope: AxisContextProjectScope,
    stepId: AxisTaskStepId,
    currentFiles: ReadonlyArray<string>,
  ) => Effect.Effect<AxisVerificationCoverage, AxisVerificationStoreError>;
}

export class AxisVerificationReporterService extends Context.Service<
  AxisVerificationReporterService,
  AxisVerificationReporter
>()("t3/axis/tasks/AxisVerificationEvidence/AxisVerificationReporterService") {}

const buildEvidence = (
  input: AxisVerificationRecordInput,
  status: AxisVerificationStatus,
  command: AxisVerificationCommand | null,
) => {
  const fingerprint = fingerprintFor({
    scope: input.scope,
    stepId: input.stepId,
    skillId: input.skillId,
    commandId: input.commandId,
    kind: input.kind,
    command,
  });
  const reason = (input.reason?.trim() ?? noteFor(command, status)).slice(0, REASON_MAX);
  return Schema.decodeUnknownSync(AxisVerificationEvidence)({
    scope: input.scope,
    stepId: input.stepId,
    skillId: input.skillId,
    commandId: input.commandId,
    turnId: input.turnId,
    kind: input.kind,
    status,
    fingerprint,
    summary: input.summary,
    reason,
    command,
    coveredFiles: [...(input.coveredFiles ?? [])],
    observedAt: input.observedAt,
  });
};

export const make = Effect.gen(function* () {
  const scope = yield* AxisProjectScope;
  const records = new Map<
    string,
    {
      readonly evidence: AxisVerificationEvidence;
      readonly coveredFiles: ReadonlyArray<string>;
      readonly turnId: TurnId | null;
    }
  >();

  const recordKey = (fingerprint: string, scope: AxisContextProjectScope, stepId: AxisTaskStepId) =>
    `${scope.contextId}|${scope.project.environmentId}|${scope.project.projectId}|${stepId}|${fingerprint}`;

  const authorize = (
    caller: { readonly environmentId: EnvironmentId; readonly contextId: AxisContextId },
    target: AxisContextProjectScope,
    operation: "read" | "write",
  ) =>
    scope
      .resolveProject({
        caller: { environmentId: caller.environmentId, contextId: caller.contextId },
        scope: target,
        operation,
      })
      .pipe(
        Effect.mapError(
          () =>
            new AxisVerificationScopeError({
              message: "Caller cannot record verification evidence for this project.",
            }),
        ),
      );

  const record: AxisVerificationReporter["record"] = (caller, raw) =>
    Effect.gen(function* () {
      const input = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          scope: AxisContextProjectScope,
          stepId: AxisTaskStepId,
          skillId: AxisSkillId,
          commandId: CommandId,
          turnId: Schema.NullOr(TurnId),
          kind: AxisVerificationKind,
          summary: Schema.String.check(
            Schema.isMinLength(1),
            Schema.isTrimmed(),
            Schema.isMaxLength(EVIDENCE_SUMMARY_MAX),
          ),
          command: Schema.NullOr(AxisVerificationCommand),
          coveredFiles: Schema.optionalKey(
            Schema.Array(
              Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(FILE_PATH_MAX)),
            ),
          ),
          observedAt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
        }),
      )(raw).pipe(
        Effect.mapError(
          () =>
            new AxisVerificationInputError({
              message: "Verification record input did not validate.",
            }),
        ),
      );
      yield* authorize(caller, input.scope, "write");
      validateCommand(input.command);
      if (input.command !== null && input.command.exitCode !== 0) {
        const stderr = (input.command.stderrExcerpt ?? "").trim();
        if (stderr.length === 0) {
          return yield* new AxisVerificationInputError({
            message:
              "A failed verification must capture stderr or annotate the failure with a non-empty reason.",
          });
        }
      }
      const status = classify(input.command);
      const evidence = buildEvidence(input, status, input.command);
      records.set(recordKey(evidence.fingerprint, input.scope, input.stepId), {
        evidence,
        coveredFiles: input.coveredFiles ?? [],
        turnId: input.turnId,
      });
      return evidence;
    });

  const markNotApplicable: AxisVerificationReporter["markNotApplicable"] = (caller, raw) =>
    Effect.gen(function* () {
      const input = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          scope: AxisContextProjectScope,
          stepId: AxisTaskStepId,
          skillId: AxisSkillId,
          commandId: CommandId,
          turnId: Schema.NullOr(TurnId),
          kind: Schema.optionalKey(AxisVerificationKind),
          summary: Schema.String.check(
            Schema.isMinLength(1),
            Schema.isTrimmed(),
            Schema.isMaxLength(EVIDENCE_SUMMARY_MAX),
          ),
          reason: TrimmedReason,
          coveredFiles: Schema.optionalKey(
            Schema.Array(
              Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(FILE_PATH_MAX)),
            ),
          ),
          observedAt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
        }),
      )(raw).pipe(
        Effect.mapError(
          () =>
            new AxisVerificationInputError({
              message: "Verification skip input did not validate.",
            }),
        ),
      );
      yield* authorize(caller, input.scope, "write");
      const evidence = buildEvidence(
        {
          scope: input.scope,
          stepId: input.stepId,
          skillId: input.skillId,
          commandId: input.commandId,
          turnId: input.turnId,
          kind: input.kind ?? "manual-check",
          summary: input.summary,
          reason: input.reason,
          command: null,
          coveredFiles: input.coveredFiles ?? [],
          observedAt: input.observedAt,
        },
        "not-applicable",
        null,
      );
      records.set(recordKey(evidence.fingerprint, input.scope, input.stepId), {
        evidence,
        coveredFiles: input.coveredFiles ?? [],
        turnId: input.turnId,
      });
      return evidence;
    });

  const coverage: AxisVerificationReporter["coverage"] = (targetScope, stepId, currentFiles) =>
    Effect.gen(function* () {
      if (currentFiles.length === 0) return "missing" as const;
      const normalized = new Set(currentFiles.map((path) => path.trim()));
      let sawCurrentEvidence = false;
      for (const entry of records.values()) {
        if (
          entry.evidence.scope.contextId !== targetScope.contextId ||
          entry.evidence.scope.project.environmentId !== targetScope.project.environmentId ||
          entry.evidence.scope.project.projectId !== targetScope.project.projectId ||
          entry.evidence.stepId !== stepId
        )
          continue;
        if (entry.evidence.status === "not-applicable" || entry.evidence.status === "not-run")
          continue;
        sawCurrentEvidence = true;
        if (entry.coveredFiles.length === 0) return "missing" as const;
        const matches = entry.coveredFiles.some((path) => normalized.has(path));
        if (!matches) return "stale" as const;
      }
      return sawCurrentEvidence ? ("covered" as const) : ("missing" as const);
    });

  return { record, markNotApplicable, coverage } satisfies AxisVerificationReporter;
});

export const layer = Layer.effect(AxisVerificationReporterService, make);
