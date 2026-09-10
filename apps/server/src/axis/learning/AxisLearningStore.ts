import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeCrypto from "node:crypto";

import {
  AxisLearningActiveVersion,
  type AxisLearningActiveVersion as AxisLearningActiveVersionType,
  type AxisLearningActivationResponse as AxisLearningActivationResponseType,
  AxisLearningConflictError,
  AxisLearningEvidence,
  type AxisLearningEvidence as AxisLearningEvidenceType,
  AxisLearningLifecycleEvent,
  type AxisLearningLifecycleEvent as AxisLearningLifecycleEventType,
  AxisLearningLifecycleEventId,
  AxisLearningNotFoundError,
  AxisLearningPersistenceError,
  AxisLearningProposal,
  AxisLearningRevisionRequiredError,
  type AxisLearningProposal as AxisLearningProposalType,
  type AxisLearningProposalDraft,
  type AxisLearningProposalId,
  type AxisLearningStoreError,
  type AxisLearningSnapshot,
  AxisLearningTransitionError,
  AxisLearningValidationError,
  AxisLearningVersion,
  type AxisLearningVersion as AxisLearningVersionType,
  AxisLearningVersionId,
  type AxisContextId,
  CommandId,
  AxisTypedChange,
  axisLearningEvidenceSemanticallyEquals,
  axisProjectScopeKey,
  type AxisLearningActivationState,
  type AxisLearningScope,
} from "@t3tools/contracts";

type JsonRow = { readonly value: unknown };
type CountRow = { readonly count: number };
type ReviewInput = {
  readonly eventId: AxisLearningLifecycleEventId;
  readonly actor: string;
  readonly note?: string;
  readonly createdAt: string;
};

type ActivationScope = AxisLearningScope;
type ActivationResponse = AxisLearningActivationResponseType;
type LearningLookup = AxisLearningScope | AxisContextId;

const contextScopeKey = "context";
const scopeKey = (scope: AxisLearningScope | undefined) =>
  scope?.project === undefined ? contextScopeKey : axisProjectScopeKey(scope.project);
const scopeOf = (scope: AxisLearningScope | undefined, contextId: AxisContextId) =>
  scope === undefined ? undefined : { ...scope, contextId };

const activationRequestDigest = (input: {
  readonly action: "activate" | "rollback" | "deactivate";
  readonly scope: ActivationScope;
  readonly targetKey: string;
  readonly versionId: AxisLearningVersionId | null;
  readonly expectedRevision: number;
  readonly note: string | null;
}) =>
  `sha256:${NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify({
        action: input.action,
        contextId: input.scope.contextId,
        scopeKey: scopeKey(input.scope),
        targetKey: input.targetKey,
        versionId: input.versionId,
        expectedRevision: input.expectedRevision,
        note: input.note,
      }),
      "utf8",
    )
    .digest("hex")}`;

const commandEventId = (
  commandId: CommandId,
  scope: ActivationScope,
): AxisLearningLifecycleEventId =>
  AxisLearningLifecycleEventId.make(
    `axis-learning-${NodeCrypto.createHash("sha256")
      .update(
        JSON.stringify({
          commandId,
          contextId: scope.contextId,
          scopeKey: scopeKey(scope),
        }),
        "utf8",
      )
      .digest("hex")}`,
  );

const decodeEvidence = Schema.decodeUnknownEffect(Schema.fromJsonString(AxisLearningEvidence));
const encodeEvidence = Schema.encodeEffect(Schema.fromJsonString(AxisLearningEvidence));
const decodeProposal = Schema.decodeUnknownEffect(Schema.fromJsonString(AxisLearningProposal));
const encodeProposal = Schema.encodeEffect(Schema.fromJsonString(AxisLearningProposal));
const decodeVersion = Schema.decodeUnknownEffect(Schema.fromJsonString(AxisLearningVersion));
const encodeVersion = Schema.encodeEffect(Schema.fromJsonString(AxisLearningVersion));
const decodeLifecycle = Schema.decodeUnknownEffect(
  Schema.fromJsonString(AxisLearningLifecycleEvent),
);
const encodeLifecycle = Schema.encodeEffect(Schema.fromJsonString(AxisLearningLifecycleEvent));
const CommandNoop = Schema.Struct({
  action: Schema.Literal("command-noop"),
  commandId: CommandId,
  requestDigest: Schema.String,
});
const encodeCommandNoop = Schema.encodeEffect(Schema.fromJsonString(CommandNoop));
const decodeCommandRecord = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Union([AxisLearningLifecycleEvent, CommandNoop])),
);
const decodeActiveVersion = Schema.decodeUnknownEffect(AxisLearningActiveVersion);
const isAxisTypedChange = Schema.is(AxisTypedChange);
const persistenceError = (operation: string) => () =>
  new AxisLearningPersistenceError({ operation });

export class AxisLearningStore extends Context.Service<
  AxisLearningStore,
  {
    readonly recordEvidence: (
      evidence: AxisLearningEvidenceType,
    ) => Effect.Effect<AxisLearningEvidenceType, AxisLearningStoreError>;
    readonly listEvidence: (
      contextId: AxisContextId,
      scope?: AxisLearningScope,
    ) => Effect.Effect<ReadonlyArray<AxisLearningEvidenceType>, AxisLearningPersistenceError>;
    readonly purgeExpiredEvidence: (
      now: string,
    ) => Effect.Effect<number, AxisLearningPersistenceError>;
    readonly createProposal: (
      draft: AxisLearningProposalDraft,
      createdAt: string,
    ) => Effect.Effect<AxisLearningProposalType, AxisLearningStoreError>;
    readonly getProposal: (
      id: AxisLearningProposalId,
      lookup?: LearningLookup,
    ) => Effect.Effect<AxisLearningProposalType, AxisLearningStoreError>;
    readonly submitForReview: (
      id: AxisLearningProposalId,
      lookup: LearningLookup,
      input: ReviewInput,
    ) => Effect.Effect<AxisLearningProposalType, AxisLearningStoreError>;
    readonly approve: (
      id: AxisLearningProposalId,
      lookup: LearningLookup,
      versionId: AxisLearningVersionId,
      input: ReviewInput,
    ) => Effect.Effect<AxisLearningVersionType, AxisLearningStoreError>;
    readonly reject: (
      id: AxisLearningProposalId,
      lookup: LearningLookup,
      input: ReviewInput,
    ) => Effect.Effect<AxisLearningProposalType, AxisLearningStoreError>;
    readonly activate: {
      (
        scope: ActivationScope,
        targetKey: string,
        versionId: AxisLearningVersionId,
        expectedRevision: number,
        commandId: CommandId,
      ): Effect.Effect<ActivationResponse, AxisLearningStoreError>;
      /** Kept for old RPC callers until their request shape is migrated. */
      (
        versionId: AxisLearningVersionId,
        input: ReviewInput,
      ): Effect.Effect<ActivationResponse, AxisLearningStoreError>;
    };
    readonly rollback: {
      (
        scope: ActivationScope,
        targetKey: string,
        versionId: AxisLearningVersionId,
        expectedRevision: number,
        commandId: CommandId,
      ): Effect.Effect<ActivationResponse, AxisLearningStoreError>;
      /** Kept for old RPC callers until their request shape is migrated. */
      (
        versionId: AxisLearningVersionId,
        input: ReviewInput,
      ): Effect.Effect<ActivationResponse, AxisLearningStoreError>;
    };
    readonly deactivate: (
      scope: ActivationScope,
      targetKey: string,
      expectedRevision: number,
      commandId: CommandId,
      note?: string,
    ) => Effect.Effect<ActivationResponse, AxisLearningStoreError>;
    readonly getActive: (
      contextId: AxisContextId,
      targetKey: string,
      scope?: AxisLearningScope,
    ) => Effect.Effect<Option.Option<AxisLearningActiveVersion>, AxisLearningStoreError>;
    readonly listLifecycle: (
      contextId: AxisContextId,
      scope?: AxisLearningScope,
    ) => Effect.Effect<ReadonlyArray<AxisLearningLifecycleEventType>, AxisLearningPersistenceError>;
    readonly getSnapshot: (
      contextId: AxisContextId,
      scope?: AxisLearningScope,
    ) => Effect.Effect<AxisLearningSnapshot, AxisLearningPersistenceError>;
  }
>()("t3/axis/learning/AxisLearningStore") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const decodeEvidenceRows = (rows: ReadonlyArray<JsonRow>) =>
    Effect.forEach(rows, (row) => decodeEvidence(row.value), { concurrency: 8 }).pipe(
      Effect.mapError(persistenceError("decode evidence")),
    );
  const decodeLifecycleRows = (rows: ReadonlyArray<JsonRow>) =>
    Effect.forEach(rows, (row) => decodeLifecycle(row.value), { concurrency: 8 }).pipe(
      Effect.mapError(persistenceError("decode lifecycle")),
    );
  const decodeProposalRows = (rows: ReadonlyArray<JsonRow>) =>
    Effect.forEach(rows, (row) => decodeProposal(row.value), { concurrency: 8 }).pipe(
      Effect.mapError(persistenceError("decode proposals")),
    );
  const decodeVersionRows = (rows: ReadonlyArray<JsonRow>) =>
    Effect.forEach(rows, (row) => decodeVersion(row.value), { concurrency: 8 }).pipe(
      Effect.mapError(persistenceError("decode versions")),
    );

  const getProposal: AxisLearningStore["Service"]["getProposal"] = Effect.fnUntraced(
    function* (id, lookup) {
      const rows = yield* (
        lookup === undefined
          ? sql<JsonRow>`
            SELECT proposal_json AS value
            FROM axis_learning_proposals
            WHERE id = ${id}
          `
          : typeof lookup === "string"
            ? sql<JsonRow>`
              SELECT proposal_json AS value
              FROM axis_learning_proposals
              WHERE id = ${id}
                AND context_id = ${lookup}
                AND scope_key = ${contextScopeKey}
            `
            : sql<JsonRow>`
              SELECT proposal_json AS value
              FROM axis_learning_proposals
              WHERE id = ${id}
                AND context_id = ${lookup.contextId}
                AND scope_key = ${scopeKey(lookup)}
            `
      ).pipe(Effect.mapError(persistenceError("read proposal")));
      if (rows[0] === undefined) {
        return yield* new AxisLearningNotFoundError({ entity: "proposal", id });
      }
      return yield* decodeProposal(rows[0].value).pipe(
        Effect.mapError(persistenceError("decode proposal")),
      );
    },
  );

  const getVersion = Effect.fnUntraced(function* (
    id: AxisLearningVersionId,
    lookup?: LearningLookup,
  ) {
    const rows = yield* (
      lookup === undefined
        ? sql<JsonRow>`
          SELECT version_json AS value
          FROM axis_learning_versions
          WHERE id = ${id}
        `
        : typeof lookup === "string"
          ? sql<JsonRow>`
            SELECT version_json AS value
            FROM axis_learning_versions
            WHERE id = ${id} AND context_id = ${lookup}
          `
          : sql<JsonRow>`
            SELECT version_json AS value
            FROM axis_learning_versions
            WHERE id = ${id}
              AND context_id = ${lookup.contextId}
              AND scope_key = ${scopeKey(lookup)}
          `
    ).pipe(Effect.mapError(persistenceError("read version")));
    if (rows[0] === undefined) {
      return yield* new AxisLearningNotFoundError({ entity: "version", id });
    }
    return yield* decodeVersion(rows[0].value).pipe(
      Effect.mapError(persistenceError("decode version")),
    );
  });

  const saveProposal = (proposal: AxisLearningProposalType) =>
    encodeProposal(proposal).pipe(
      Effect.mapError(persistenceError("encode proposal")),
      Effect.flatMap(
        (json) => sql`
          UPDATE axis_learning_proposals
          SET status = ${proposal.status}, proposal_json = ${json}, updated_at = ${proposal.updatedAt}
          WHERE id = ${proposal.id}
            AND context_id = ${proposal.contextId}
            AND scope_key = ${scopeKey(proposal.scope)}
        `,
      ),
      Effect.as(proposal),
      Effect.mapError(persistenceError("update proposal")),
    );

  const saveLifecycle = (event: AxisLearningLifecycleEventType) =>
    encodeLifecycle(event).pipe(
      Effect.mapError(persistenceError("encode lifecycle event")),
      Effect.flatMap(
        (json) => sql`
          INSERT INTO axis_learning_lifecycle_events
            (id, context_id, scope_key, proposal_id, version_id, action, event_json, created_at)
          VALUES
            (${event.id}, ${event.contextId}, ${scopeKey(event.scope)}, ${event.proposalId}, ${event.versionId},
             ${event.action}, ${json}, ${event.createdAt})
        `,
      ),
      Effect.asVoid,
      Effect.mapError(persistenceError("save lifecycle event")),
    );

  const requireStatus = (
    proposal: AxisLearningProposalType,
    expected: "draft" | "in-review",
    action: string,
  ) =>
    proposal.status === expected
      ? Effect.succeed(proposal)
      : Effect.fail(
          new AxisLearningTransitionError({
            proposalId: proposal.id,
            status: proposal.status,
            action,
          }),
        );

  const recordEvidence: AxisLearningStore["Service"]["recordEvidence"] = (evidence) => {
    if (Date.parse(evidence.expiresAt) <= Date.parse(evidence.createdAt)) {
      return Effect.fail(
        new AxisLearningValidationError({ message: "Evidence expiry must follow creation." }),
      );
    }
    const evidenceScope = evidence.provenance.scope;
    const evidenceScopeKey = scopeKey(evidenceScope);
    return encodeEvidence(evidence).pipe(
      Effect.mapError(persistenceError("encode evidence")),
      Effect.flatMap(
        (json) => sql<{ readonly id: string }>`
          INSERT INTO axis_learning_evidence
            (id, context_id, scope_key, fingerprint, evidence_json, expires_at, created_at)
          VALUES
            (${evidence.id}, ${evidence.provenance.contextId}, ${evidenceScopeKey}, ${evidence.provenance.fingerprint},
             ${json}, ${evidence.expiresAt}, ${evidence.createdAt})
          ON CONFLICT (context_id, scope_key, fingerprint) DO NOTHING
          RETURNING id
        `,
      ),
      Effect.mapError(persistenceError("record evidence")),
      Effect.flatMap((rows) =>
        rows.length > 0
          ? Effect.succeed(evidence)
          : sql<JsonRow>`
              SELECT evidence_json AS value FROM axis_learning_evidence
              WHERE context_id = ${evidence.provenance.contextId}
                AND scope_key = ${evidenceScopeKey}
                AND fingerprint = ${evidence.provenance.fingerprint}
            `.pipe(
              Effect.mapError(persistenceError("read canonical evidence")),
              Effect.flatMap((canonicalRows) =>
                canonicalRows[0] === undefined
                  ? Effect.fail(
                      new AxisLearningConflictError({ entity: "evidence", id: evidence.id }),
                    )
                  : decodeEvidence(canonicalRows[0].value).pipe(
                      Effect.mapError(persistenceError("decode canonical evidence")),
                      Effect.flatMap((canonical) =>
                        axisLearningEvidenceSemanticallyEquals(canonical, evidence)
                          ? Effect.succeed(canonical)
                          : Effect.fail(
                              new AxisLearningConflictError({
                                entity: "evidence",
                                id: canonical.id,
                              }),
                            ),
                      ),
                    ),
              ),
            ),
      ),
    );
  };

  const listEvidence: AxisLearningStore["Service"]["listEvidence"] = (contextId, scope) =>
    sql<JsonRow>`
      SELECT evidence_json AS value FROM axis_learning_evidence
      WHERE context_id = ${contextId} AND scope_key = ${scopeKey(scope)} ORDER BY created_at, id
    `.pipe(Effect.mapError(persistenceError("list evidence")), Effect.flatMap(decodeEvidenceRows));

  const purgeExpiredEvidence: AxisLearningStore["Service"]["purgeExpiredEvidence"] = (now) =>
    sql<CountRow>`
      DELETE FROM axis_learning_evidence WHERE scope_key IS NOT NULL AND expires_at <= ${now}
      RETURNING 1 AS count
    `.pipe(
      Effect.map((rows) => rows.length),
      Effect.mapError(persistenceError("purge expired evidence")),
    );

  const createProposal: AxisLearningStore["Service"]["createProposal"] = (draft, createdAt) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const uniqueEvidenceIds = [...new Set(draft.evidenceIds)];
          if (uniqueEvidenceIds.length !== draft.evidenceIds.length) {
            return yield* new AxisLearningValidationError({
              message: "Proposal evidence ids must be unique.",
            });
          }
          const evidenceRows = yield* sql<{
            readonly id: string;
            readonly contextId: string;
            readonly scopeKey: string;
          }>`
          SELECT id, context_id AS "contextId", scope_key AS "scopeKey"
          FROM axis_learning_evidence
          WHERE id IN ${sql.in(uniqueEvidenceIds)}
            AND context_id = ${draft.contextId}
            AND scope_key = ${scopeKey(draft.scope)}
        `;
          if (
            evidenceRows.length !== uniqueEvidenceIds.length ||
            evidenceRows.some(
              (row) => row.contextId !== draft.contextId || row.scopeKey !== scopeKey(draft.scope),
            )
          ) {
            return yield* new AxisLearningValidationError({
              message: "Every proposal evidence record must exist in the same context and scope.",
            });
          }
          const proposal: AxisLearningProposalType = {
            ...draft,
            status: "draft",
            createdAt,
            updatedAt: createdAt,
            reviewedAt: null,
            reviewedBy: null,
            reviewNote: null,
          };
          const json = yield* encodeProposal(proposal).pipe(
            Effect.mapError(persistenceError("encode proposal")),
          );
          const rows = yield* sql<{ readonly id: string }>`
          INSERT INTO axis_learning_proposals
            (id, context_id, scope_key, target_key, status, proposal_json, created_at, updated_at)
          VALUES
            (${proposal.id}, ${proposal.contextId}, ${scopeKey(proposal.scope)}, ${proposal.targetKey}, ${proposal.status},
             ${json}, ${proposal.createdAt}, ${proposal.updatedAt})
          ON CONFLICT (id) DO NOTHING RETURNING id
        `;
          return rows.length === 0
            ? yield* new AxisLearningConflictError({ entity: "proposal", id: proposal.id })
            : proposal;
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", () =>
          Effect.fail(new AxisLearningPersistenceError({ operation: "create proposal" })),
        ),
      );

  const submitForReview: AxisLearningStore["Service"]["submitForReview"] = (id, lookup, input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const proposal = yield* getProposal(id, lookup);
          yield* requireStatus(proposal, "draft", "submit");
          const next = yield* saveProposal({
            ...proposal,
            status: "in-review",
            updatedAt: input.createdAt,
          });
          yield* saveLifecycle({
            id: input.eventId,
            contextId: proposal.contextId,
            ...(proposal.scope === undefined ? {} : { scope: proposal.scope }),
            action: "submitted",
            proposalId: proposal.id,
            versionId: null,
            previousVersionId: null,
            actor: input.actor,
            note: input.note ?? null,
            createdAt: input.createdAt,
          });
          return next;
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", () =>
          Effect.fail(
            new AxisLearningPersistenceError({ operation: "submit proposal for review" }),
          ),
        ),
      );

  const approve: AxisLearningStore["Service"]["approve"] = (id, lookup, versionId, input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const proposal = yield* getProposal(id, lookup);
          yield* requireStatus(proposal, "in-review", "approve");
          const version: AxisLearningVersionType = {
            id: versionId,
            proposalId: proposal.id,
            contextId: proposal.contextId,
            ...(proposal.scope === undefined ? {} : { scope: proposal.scope }),
            kind: proposal.kind,
            targetKey: proposal.targetKey,
            ...(proposal.targetProvider !== undefined
              ? { targetProvider: proposal.targetProvider }
              : {}),
            title: proposal.title,
            rationale: proposal.rationale,
            evidenceIds: proposal.evidenceIds,
            change: proposal.change,
            approvedBy: input.actor,
            createdAt: input.createdAt,
          };
          const versionJson = yield* encodeVersion(version).pipe(
            Effect.mapError(persistenceError("encode version")),
          );
          yield* sql`
          INSERT INTO axis_learning_versions
            (id, proposal_id, context_id, scope_key, target_key, version_json, created_at)
          VALUES
            (${version.id}, ${version.proposalId}, ${version.contextId}, ${scopeKey(version.scope)}, ${version.targetKey},
             ${versionJson}, ${version.createdAt})
        `;
          yield* saveProposal({
            ...proposal,
            status: "approved",
            updatedAt: input.createdAt,
            reviewedAt: input.createdAt,
            reviewedBy: input.actor,
            reviewNote: input.note ?? null,
          });
          yield* saveLifecycle({
            id: input.eventId,
            contextId: proposal.contextId,
            ...(proposal.scope === undefined ? {} : { scope: proposal.scope }),
            action: "approved",
            proposalId: proposal.id,
            versionId: version.id,
            previousVersionId: null,
            actor: input.actor,
            note: input.note ?? null,
            createdAt: input.createdAt,
          });
          return version;
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", () =>
          Effect.fail(new AxisLearningPersistenceError({ operation: "approve proposal" })),
        ),
      );

  const reject: AxisLearningStore["Service"]["reject"] = (id, lookup, input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const proposal = yield* getProposal(id, lookup);
          yield* requireStatus(proposal, "in-review", "reject");
          const next = yield* saveProposal({
            ...proposal,
            status: "rejected",
            updatedAt: input.createdAt,
            reviewedAt: input.createdAt,
            reviewedBy: input.actor,
            reviewNote: input.note ?? null,
          });
          yield* saveLifecycle({
            id: input.eventId,
            contextId: proposal.contextId,
            ...(proposal.scope === undefined ? {} : { scope: proposal.scope }),
            action: "rejected",
            proposalId: proposal.id,
            versionId: null,
            previousVersionId: null,
            actor: input.actor,
            note: input.note ?? null,
            createdAt: input.createdAt,
          });
          return next;
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", () =>
          Effect.fail(new AxisLearningPersistenceError({ operation: "reject proposal" })),
        ),
      );

  const getActive: AxisLearningStore["Service"]["getActive"] = (contextId, targetKey, scope) =>
    sql<{
      readonly versionId: string | null;
      readonly activatedAt: string;
      readonly scopeKey: string;
    }>`
      SELECT version_id AS "versionId", activated_at AS "activatedAt"
      FROM axis_learning_active_versions
      WHERE context_id = ${contextId} AND scope_key = ${scopeKey(scope)} AND target_key = ${targetKey}
    `.pipe(
      Effect.mapError(persistenceError("read active version")),
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.succeed(Option.none())
          : rows[0].versionId === null
            ? Effect.succeed(Option.none())
            : decodeActiveVersion({
                contextId,
                ...(scope === undefined ? {} : { scope }),
                targetKey,
                versionId: rows[0].versionId,
                activatedAt: rows[0].activatedAt,
              }).pipe(
                Effect.map(Option.some),
                Effect.mapError(persistenceError("decode active version")),
              ),
      ),
    );

  const getActivationState = (scope: ActivationScope, targetKey: string) =>
    sql<{
      readonly versionId: string | null;
      readonly revision: number;
      readonly updatedAt: string | null;
    }>`
      SELECT version_id AS "versionId", revision, updated_at AS "updatedAt"
      FROM axis_learning_active_versions
      WHERE context_id = ${scope.contextId} AND scope_key = ${scopeKey(scope)} AND target_key = ${targetKey}
    `.pipe(
      Effect.mapError(persistenceError("read activation state")),
      Effect.map((rows) =>
        rows[0] === undefined
          ? ({ scope, targetKey, versionId: null, revision: 0, updatedAt: null } as ActivationState)
          : ({
              scope,
              targetKey,
              versionId: rows[0].versionId,
              revision: rows[0].revision,
              updatedAt: rows[0].updatedAt,
            } as ActivationState),
      ),
    );

  type ActivationState = AxisLearningActivationState;

  const findCommandEvent = (scope: ActivationScope, commandId: CommandId) =>
    sql<JsonRow>`
      SELECT event_json AS value
      FROM axis_learning_lifecycle_events
      WHERE context_id = ${scope.contextId}
        AND scope_key = ${scopeKey(scope)}
        AND json_extract(event_json, '$.commandId') = ${commandId}
      ORDER BY created_at, id
      LIMIT 1
    `.pipe(
      Effect.mapError(persistenceError("read activation command")),
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.succeed(
              Option.none<
                | AxisLearningLifecycleEventType
                | { readonly action: "command-noop"; readonly requestDigest: string }
              >(),
            )
          : decodeCommandRecord(rows[0].value).pipe(
              Effect.map(Option.some),
              Effect.mapError(persistenceError("decode activation command")),
            ),
      ),
    );

  const validateActivationVersion = (
    scope: ActivationScope,
    targetKey: string,
    versionId: AxisLearningVersionId,
  ) =>
    Effect.gen(function* () {
      const version = yield* getVersion(versionId, scope);
      const proposal = yield* getProposal(version.proposalId, scope);
      if (proposal.status !== "approved" || !isAxisTypedChange(version.change)) {
        return yield* new AxisLearningValidationError({
          message: "Only approved versions with typed changes can be activated.",
        });
      }
      if (
        version.contextId !== scope.contextId ||
        version.targetKey !== targetKey ||
        scopeKey(version.scope) !== scopeKey(scope) ||
        proposal.contextId !== scope.contextId ||
        proposal.targetKey !== targetKey ||
        scopeKey(proposal.scope) !== scopeKey(scope)
      ) {
        return yield* new AxisLearningValidationError({
          message: "The version must belong to the requested target and scope.",
        });
      }
      return version;
    });

  const commandConflict = (commandId: CommandId) =>
    new AxisLearningConflictError({ entity: "activation-command", id: commandId });
  const revisionConflict = (targetKey: string) =>
    new AxisLearningConflictError({ entity: "activation-state", id: targetKey });

  const setActive = (
    action: "activated" | "rolled-back",
    scope: ActivationScope,
    targetKey: string,
    versionId: AxisLearningVersionId,
    expectedRevision: number,
    commandId: CommandId,
  ): Effect.Effect<ActivationResponse, AxisLearningStoreError> => {
    const requestDigest = activationRequestDigest({
      action: action === "activated" ? "activate" : "rollback",
      scope,
      targetKey,
      versionId,
      expectedRevision,
      note: null,
    });
    return sql
      .withTransaction(
        Effect.gen(function* () {
          const previousCommand = yield* findCommandEvent(scope, commandId);
          if (Option.isSome(previousCommand)) {
            if (previousCommand.value.requestDigest !== requestDigest) {
              return yield* commandConflict(commandId);
            }
            return {
              activeState: yield* getActivationState(scope, targetKey),
              lifecycleEvent:
                previousCommand.value.action === "command-noop" ? null : previousCommand.value,
            };
          }
          const version = yield* validateActivationVersion(scope, targetKey, versionId);
          const currentState = yield* getActivationState(scope, targetKey);
          if (currentState.revision !== expectedRevision) {
            return yield* revisionConflict(targetKey);
          }
          if (action === "rolled-back" && currentState.versionId === null) {
            return yield* new AxisLearningValidationError({
              message: "Rollback requires an active version.",
            });
          }
          if (action === "rolled-back" && currentState.versionId === versionId) {
            return yield* new AxisLearningValidationError({
              message: "Rollback target must differ from the active version.",
            });
          }

          const createdAt = DateTime.formatIso(DateTime.nowUnsafe());
          const resultingRevision = expectedRevision + 1;
          const updated = yield* expectedRevision === 0
            ? sql<{ readonly revision: number }>`
                INSERT INTO axis_learning_active_versions
                  (context_id, scope_key, target_key, version_id, activated_at, revision, updated_at)
                VALUES
                  (${scope.contextId}, ${scopeKey(scope)}, ${targetKey}, ${versionId},
                   ${createdAt}, ${resultingRevision}, ${createdAt})
                ON CONFLICT (context_id, scope_key, target_key) DO UPDATE SET
                  version_id = excluded.version_id,
                  activated_at = excluded.activated_at,
                  revision = excluded.revision,
                  updated_at = excluded.updated_at
                WHERE axis_learning_active_versions.revision = ${expectedRevision}
                RETURNING revision
              `
            : sql<{ readonly revision: number }>`
                UPDATE axis_learning_active_versions
                SET version_id = ${versionId}, activated_at = ${createdAt},
                    revision = ${resultingRevision}, updated_at = ${createdAt}
                WHERE context_id = ${scope.contextId}
                  AND scope_key = ${scopeKey(scope)}
                  AND target_key = ${targetKey}
                  AND revision = ${expectedRevision}
                RETURNING revision
              `;
          if (updated.length === 0) {
            return yield* revisionConflict(targetKey);
          }

          const event: AxisLearningLifecycleEventType = {
            id: commandEventId(commandId, scope),
            contextId: scope.contextId,
            scope,
            action: action === "activated" ? "activated" : "rolled-back",
            proposalId: version.proposalId,
            versionId,
            previousVersionId: currentState.versionId,
            actor: "axis-learning-queue",
            note: null,
            createdAt,
            commandId,
            requestDigest,
            resultingRevision,
          };
          yield* saveLifecycle(event);
          return {
            activeState: yield* getActivationState(scope, targetKey),
            lifecycleEvent: event,
          };
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", () =>
          Effect.fail(new AxisLearningPersistenceError({ operation: action })),
        ),
      );
  };

  const deactivate: AxisLearningStore["Service"]["deactivate"] = (
    scope,
    targetKey,
    expectedRevision,
    commandId,
    note,
  ) => {
    const requestDigest = activationRequestDigest({
      action: "deactivate",
      scope,
      targetKey,
      versionId: null,
      expectedRevision,
      note: note ?? null,
    });
    return sql
      .withTransaction(
        Effect.gen(function* () {
          const previousCommand = yield* findCommandEvent(scope, commandId);
          if (Option.isSome(previousCommand)) {
            if (previousCommand.value.requestDigest !== requestDigest) {
              return yield* commandConflict(commandId);
            }
            return {
              activeState: yield* getActivationState(scope, targetKey),
              lifecycleEvent:
                previousCommand.value.action === "command-noop" ? null : previousCommand.value,
            };
          }
          const currentState = yield* getActivationState(scope, targetKey);
          if (currentState.revision !== expectedRevision) {
            return yield* revisionConflict(targetKey);
          }
          if (currentState.versionId === null) {
            // Keep command identity in the existing immutable journal without emitting a lifecycle transition.
            const commandJson = yield* encodeCommandNoop({
              action: "command-noop",
              commandId,
              requestDigest,
            }).pipe(Effect.mapError(persistenceError("encode command no-op")));
            const reserved = yield* sql<{ readonly id: string }>`
              INSERT INTO axis_learning_lifecycle_events
                (id, context_id, scope_key, proposal_id, version_id, action, event_json, created_at)
              VALUES (${commandEventId(commandId, scope)}, ${scope.contextId}, ${scopeKey(scope)},
                NULL, NULL, 'command-noop',
                ${commandJson},
                ${DateTime.formatIso(DateTime.nowUnsafe())})
              ON CONFLICT (id) DO NOTHING
              RETURNING id
            `;
            if (reserved.length === 0) {
              const racedCommand = yield* findCommandEvent(scope, commandId);
              if (
                Option.isNone(racedCommand) ||
                racedCommand.value.requestDigest !== requestDigest
              ) {
                return yield* commandConflict(commandId);
              }
            }
            return {
              activeState: yield* getActivationState(scope, targetKey),
              lifecycleEvent: null,
            };
          }

          const createdAt = DateTime.formatIso(DateTime.nowUnsafe());
          const resultingRevision = expectedRevision + 1;
          const previousVersion = yield* getVersion(
            AxisLearningVersionId.make(currentState.versionId),
            scope,
          );
          const updated = yield* sql<{ readonly revision: number }>`
            UPDATE axis_learning_active_versions
            SET version_id = NULL, activated_at = NULL, revision = ${resultingRevision},
                updated_at = ${createdAt}
            WHERE context_id = ${scope.contextId}
              AND scope_key = ${scopeKey(scope)}
              AND target_key = ${targetKey}
              AND revision = ${expectedRevision}
            RETURNING revision
          `;
          if (updated.length === 0) {
            return yield* revisionConflict(targetKey);
          }

          const event: AxisLearningLifecycleEventType = {
            id: commandEventId(commandId, scope),
            contextId: scope.contextId,
            scope,
            action: "deactivated",
            proposalId: previousVersion.proposalId,
            versionId: null,
            previousVersionId: currentState.versionId,
            actor: "axis-learning-queue",
            note: note ?? null,
            createdAt,
            commandId,
            requestDigest,
            resultingRevision,
          };
          yield* saveLifecycle(event);
          return {
            activeState: yield* getActivationState(scope, targetKey),
            lifecycleEvent: event,
          };
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", () =>
          Effect.fail(new AxisLearningPersistenceError({ operation: "deactivate" })),
        ),
      );
  };

  const activate: AxisLearningStore["Service"]["activate"] = (
    scopeOrVersionId: ActivationScope | AxisLearningVersionId,
    targetKeyOrInput: string | ReviewInput,
    versionId?: AxisLearningVersionId,
    expectedRevision?: number,
    commandId?: CommandId,
  ) =>
    typeof scopeOrVersionId === "string"
      ? Effect.fail(
          new AxisLearningRevisionRequiredError({
            message: "Activation requires scope, target, expectedRevision, and commandId.",
          }),
        )
      : setActive(
          "activated",
          scopeOrVersionId,
          targetKeyOrInput as string,
          versionId!,
          expectedRevision!,
          commandId!,
        );

  const rollback: AxisLearningStore["Service"]["rollback"] = (
    scopeOrVersionId: ActivationScope | AxisLearningVersionId,
    targetKeyOrInput: string | ReviewInput,
    versionId?: AxisLearningVersionId,
    expectedRevision?: number,
    commandId?: CommandId,
  ) =>
    typeof scopeOrVersionId === "string"
      ? Effect.fail(
          new AxisLearningRevisionRequiredError({
            message: "Rollback requires scope, target, expectedRevision, and commandId.",
          }),
        )
      : setActive(
          "rolled-back",
          scopeOrVersionId,
          targetKeyOrInput as string,
          versionId!,
          expectedRevision!,
          commandId!,
        );

  const listLifecycle: AxisLearningStore["Service"]["listLifecycle"] = (contextId, scope) =>
    sql<JsonRow>`
      SELECT event_json AS value FROM axis_learning_lifecycle_events
      WHERE context_id = ${contextId} AND scope_key = ${scopeKey(scope)}
        AND action != 'command-noop'
      ORDER BY created_at, id
    `.pipe(
      Effect.mapError(persistenceError("list lifecycle")),
      Effect.flatMap(decodeLifecycleRows),
    );

  const getSnapshot: AxisLearningStore["Service"]["getSnapshot"] = (contextId, scope) =>
    Effect.all({
      evidence: listEvidence(contextId, scope),
      proposals: sql<JsonRow>`
        SELECT proposal_json AS value FROM axis_learning_proposals
        WHERE context_id = ${contextId} AND scope_key = ${scopeKey(scope)} ORDER BY updated_at DESC, id
      `.pipe(
        Effect.mapError(persistenceError("list proposals")),
        Effect.flatMap(decodeProposalRows),
      ),
      versions: sql<JsonRow>`
        SELECT version_json AS value FROM axis_learning_versions
        WHERE context_id = ${contextId} AND scope_key = ${scopeKey(scope)} ORDER BY created_at DESC, id
      `.pipe(Effect.mapError(persistenceError("list versions")), Effect.flatMap(decodeVersionRows)),
      activeVersions: sql<{
        readonly targetKey: string;
        readonly versionId: string;
        readonly activatedAt: string;
        readonly scopeKey: string;
      }>`
          SELECT target_key AS "targetKey", version_id AS "versionId",
               activated_at AS "activatedAt"
        FROM axis_learning_active_versions
        WHERE context_id = ${contextId} AND scope_key = ${scopeKey(scope)} AND version_id IS NOT NULL
        ORDER BY target_key
      `.pipe(
        Effect.mapError(persistenceError("list active versions")),
        Effect.flatMap((rows) =>
          Effect.forEach(
            rows,
            (row) =>
              decodeActiveVersion({
                contextId,
                ...(scope === undefined ? {} : { scope }),
                ...row,
              }).pipe(Effect.mapError(persistenceError("decode active versions"))),
            { concurrency: 8 },
          ),
        ),
      ) as Effect.Effect<
        ReadonlyArray<AxisLearningActiveVersionType>,
        AxisLearningPersistenceError
      >,
      activeStates: sql<{
        readonly targetKey: string;
        readonly versionId: string | null;
        readonly revision: number;
        readonly updatedAt: string | null;
      }>`
        SELECT target_key AS "targetKey", version_id AS "versionId", revision, updated_at AS "updatedAt"
        FROM axis_learning_active_versions
        WHERE context_id = ${contextId} AND scope_key = ${scopeKey(scope)} ORDER BY target_key
      `.pipe(
        Effect.mapError(persistenceError("list active states")),
        Effect.map((rows) =>
          rows.map(
            (row) =>
              ({
                scope: scopeOf(scope, contextId) ?? { contextId },
                ...row,
              }) as AxisLearningActivationState,
          ),
        ),
      ),
      lifecycle: listLifecycle(contextId, scope),
    }).pipe(Effect.map((snapshot) => ({ contextId, ...snapshot })));

  return {
    recordEvidence,
    listEvidence,
    purgeExpiredEvidence,
    createProposal,
    getProposal,
    submitForReview,
    approve,
    reject,
    activate,
    rollback,
    deactivate,
    getActive,
    listLifecycle,
    getSnapshot,
  } satisfies AxisLearningStore["Service"];
});

export const layer = Layer.effect(AxisLearningStore, make);
