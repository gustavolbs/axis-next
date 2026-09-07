import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  AxisLearningActiveVersion,
  type AxisLearningActiveVersion as AxisLearningActiveVersionType,
  AxisLearningConflictError,
  AxisLearningEvidence,
  type AxisLearningEvidence as AxisLearningEvidenceType,
  AxisLearningLifecycleEvent,
  type AxisLearningLifecycleEvent as AxisLearningLifecycleEventType,
  type AxisLearningLifecycleEventId,
  AxisLearningNotFoundError,
  AxisLearningPersistenceError,
  AxisLearningProposal,
  type AxisLearningProposal as AxisLearningProposalType,
  type AxisLearningProposalDraft,
  type AxisLearningProposalId,
  type AxisLearningStoreError,
  type AxisLearningSnapshot,
  AxisLearningTransitionError,
  AxisLearningValidationError,
  AxisLearningVersion,
  type AxisLearningVersion as AxisLearningVersionType,
  type AxisLearningVersionId,
  type AxisContextId,
} from "@t3tools/contracts";

type JsonRow = { readonly value: unknown };
type CountRow = { readonly count: number };
type ReviewInput = {
  readonly eventId: AxisLearningLifecycleEventId;
  readonly actor: string;
  readonly note?: string;
  readonly createdAt: string;
};

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
const decodeActiveVersion = Schema.decodeUnknownEffect(AxisLearningActiveVersion);
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
    ) => Effect.Effect<AxisLearningProposalType, AxisLearningStoreError>;
    readonly submitForReview: (
      id: AxisLearningProposalId,
      input: ReviewInput,
    ) => Effect.Effect<AxisLearningProposalType, AxisLearningStoreError>;
    readonly approve: (
      id: AxisLearningProposalId,
      versionId: AxisLearningVersionId,
      input: ReviewInput,
    ) => Effect.Effect<AxisLearningVersionType, AxisLearningStoreError>;
    readonly reject: (
      id: AxisLearningProposalId,
      input: ReviewInput,
    ) => Effect.Effect<AxisLearningProposalType, AxisLearningStoreError>;
    readonly activate: (
      versionId: AxisLearningVersionId,
      input: ReviewInput,
    ) => Effect.Effect<AxisLearningActiveVersion, AxisLearningStoreError>;
    readonly rollback: (
      versionId: AxisLearningVersionId,
      input: ReviewInput,
    ) => Effect.Effect<AxisLearningActiveVersion, AxisLearningStoreError>;
    readonly getActive: (
      contextId: AxisContextId,
      targetKey: string,
    ) => Effect.Effect<Option.Option<AxisLearningActiveVersion>, AxisLearningStoreError>;
    readonly listLifecycle: (
      contextId: AxisContextId,
    ) => Effect.Effect<ReadonlyArray<AxisLearningLifecycleEventType>, AxisLearningPersistenceError>;
    readonly getSnapshot: (
      contextId: AxisContextId,
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
    function* (id) {
      const rows = yield* sql<JsonRow>`
        SELECT proposal_json AS value FROM axis_learning_proposals WHERE id = ${id}
      `.pipe(Effect.mapError(persistenceError("read proposal")));
      if (rows[0] === undefined) {
        return yield* new AxisLearningNotFoundError({ entity: "proposal", id });
      }
      return yield* decodeProposal(rows[0].value).pipe(
        Effect.mapError(persistenceError("decode proposal")),
      );
    },
  );

  const getVersion = Effect.fnUntraced(function* (id: AxisLearningVersionId) {
    const rows = yield* sql<JsonRow>`
      SELECT version_json AS value FROM axis_learning_versions WHERE id = ${id}
    `.pipe(Effect.mapError(persistenceError("read version")));
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
            (id, context_id, proposal_id, version_id, action, event_json, created_at)
          VALUES
            (${event.id}, ${event.contextId}, ${event.proposalId}, ${event.versionId},
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
    return encodeEvidence(evidence).pipe(
      Effect.mapError(persistenceError("encode evidence")),
      Effect.flatMap(
        (json) => sql<{ readonly id: string }>`
          INSERT INTO axis_learning_evidence
            (id, context_id, fingerprint, evidence_json, expires_at, created_at)
          VALUES
            (${evidence.id}, ${evidence.provenance.contextId}, ${evidence.provenance.fingerprint},
             ${json}, ${evidence.expiresAt}, ${evidence.createdAt})
          ON CONFLICT DO NOTHING
          RETURNING id
        `,
      ),
      Effect.mapError(persistenceError("record evidence")),
      Effect.flatMap((rows) =>
        rows.length === 0
          ? Effect.fail(new AxisLearningConflictError({ entity: "evidence", id: evidence.id }))
          : Effect.succeed(evidence),
      ),
    );
  };

  const listEvidence: AxisLearningStore["Service"]["listEvidence"] = (contextId) =>
    sql<JsonRow>`
      SELECT evidence_json AS value FROM axis_learning_evidence
      WHERE context_id = ${contextId} ORDER BY created_at, id
    `.pipe(Effect.mapError(persistenceError("list evidence")), Effect.flatMap(decodeEvidenceRows));

  const purgeExpiredEvidence: AxisLearningStore["Service"]["purgeExpiredEvidence"] = (now) =>
    sql<CountRow>`
      DELETE FROM axis_learning_evidence WHERE expires_at <= ${now}
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
          const evidenceRows = yield* sql<{ readonly id: string; readonly contextId: string }>`
          SELECT id, context_id AS "contextId" FROM axis_learning_evidence
          WHERE id IN ${sql.in(uniqueEvidenceIds)}
        `;
          if (
            evidenceRows.length !== uniqueEvidenceIds.length ||
            evidenceRows.some((row) => row.contextId !== draft.contextId)
          ) {
            return yield* new AxisLearningValidationError({
              message: "Every proposal evidence record must exist in the same context.",
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
            (id, context_id, target_key, status, proposal_json, created_at, updated_at)
          VALUES
            (${proposal.id}, ${proposal.contextId}, ${proposal.targetKey}, ${proposal.status},
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

  const submitForReview: AxisLearningStore["Service"]["submitForReview"] = (id, input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const proposal = yield* getProposal(id);
          yield* requireStatus(proposal, "draft", "submit");
          const next = yield* saveProposal({
            ...proposal,
            status: "in-review",
            updatedAt: input.createdAt,
          });
          yield* saveLifecycle({
            id: input.eventId,
            contextId: proposal.contextId,
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

  const approve: AxisLearningStore["Service"]["approve"] = (id, versionId, input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const proposal = yield* getProposal(id);
          yield* requireStatus(proposal, "in-review", "approve");
          const version: AxisLearningVersionType = {
            id: versionId,
            proposalId: proposal.id,
            contextId: proposal.contextId,
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
            (id, proposal_id, context_id, target_key, version_json, created_at)
          VALUES
            (${version.id}, ${version.proposalId}, ${version.contextId}, ${version.targetKey},
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

  const reject: AxisLearningStore["Service"]["reject"] = (id, input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const proposal = yield* getProposal(id);
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

  const getActive: AxisLearningStore["Service"]["getActive"] = (contextId, targetKey) =>
    sql<{ readonly versionId: string; readonly activatedAt: string }>`
      SELECT version_id AS "versionId", activated_at AS "activatedAt"
      FROM axis_learning_active_versions
      WHERE context_id = ${contextId} AND target_key = ${targetKey}
    `.pipe(
      Effect.mapError(persistenceError("read active version")),
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.succeed(Option.none())
          : decodeActiveVersion({
              contextId,
              targetKey,
              versionId: rows[0].versionId,
              activatedAt: rows[0].activatedAt,
            }).pipe(
              Effect.map(Option.some),
              Effect.mapError(persistenceError("decode active version")),
            ),
      ),
    );

  const setActive = (
    action: "activated" | "rolled-back",
    versionId: AxisLearningVersionId,
    input: ReviewInput,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const version = yield* getVersion(versionId);
          const current = yield* getActive(version.contextId, version.targetKey);
          const previousVersionId = Option.isSome(current) ? current.value.versionId : null;
          if (action === "rolled-back" && previousVersionId === null) {
            return yield* new AxisLearningValidationError({
              message: "Rollback requires an active version.",
            });
          }
          if (action === "rolled-back" && previousVersionId === versionId) {
            return yield* new AxisLearningValidationError({
              message: "Rollback target must differ from the active version.",
            });
          }
          yield* sql`
          INSERT INTO axis_learning_active_versions
            (context_id, target_key, version_id, activated_at)
          VALUES (${version.contextId}, ${version.targetKey}, ${version.id}, ${input.createdAt})
          ON CONFLICT (context_id, target_key) DO UPDATE SET
            version_id = excluded.version_id,
            activated_at = excluded.activated_at
        `;
          yield* saveLifecycle({
            id: input.eventId,
            contextId: version.contextId,
            action,
            proposalId: version.proposalId,
            versionId: version.id,
            previousVersionId,
            actor: input.actor,
            note: input.note ?? null,
            createdAt: input.createdAt,
          });
          return yield* decodeActiveVersion({
            contextId: version.contextId,
            targetKey: version.targetKey,
            versionId: version.id,
            activatedAt: input.createdAt,
          }).pipe(Effect.mapError(persistenceError("decode active version")));
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", () =>
          Effect.fail(new AxisLearningPersistenceError({ operation: action })),
        ),
      );

  const listLifecycle: AxisLearningStore["Service"]["listLifecycle"] = (contextId) =>
    sql<JsonRow>`
      SELECT event_json AS value FROM axis_learning_lifecycle_events
      WHERE context_id = ${contextId} ORDER BY created_at, id
    `.pipe(
      Effect.mapError(persistenceError("list lifecycle")),
      Effect.flatMap(decodeLifecycleRows),
    );

  const getSnapshot: AxisLearningStore["Service"]["getSnapshot"] = (contextId) =>
    Effect.all({
      evidence: listEvidence(contextId),
      proposals: sql<JsonRow>`
        SELECT proposal_json AS value FROM axis_learning_proposals
        WHERE context_id = ${contextId} ORDER BY updated_at DESC, id
      `.pipe(
        Effect.mapError(persistenceError("list proposals")),
        Effect.flatMap(decodeProposalRows),
      ),
      versions: sql<JsonRow>`
        SELECT version_json AS value FROM axis_learning_versions
        WHERE context_id = ${contextId} ORDER BY created_at DESC, id
      `.pipe(Effect.mapError(persistenceError("list versions")), Effect.flatMap(decodeVersionRows)),
      activeVersions: sql<{
        readonly targetKey: string;
        readonly versionId: string;
        readonly activatedAt: string;
      }>`
        SELECT target_key AS "targetKey", version_id AS "versionId",
               activated_at AS "activatedAt"
        FROM axis_learning_active_versions
        WHERE context_id = ${contextId} ORDER BY target_key
      `.pipe(
        Effect.mapError(persistenceError("list active versions")),
        Effect.flatMap((rows) =>
          Effect.forEach(
            rows,
            (row) =>
              decodeActiveVersion({ contextId, ...row }).pipe(
                Effect.mapError(persistenceError("decode active versions")),
              ),
            { concurrency: 8 },
          ),
        ),
      ) as Effect.Effect<
        ReadonlyArray<AxisLearningActiveVersionType>,
        AxisLearningPersistenceError
      >,
      lifecycle: listLifecycle(contextId),
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
    activate: (versionId, input) => setActive("activated", versionId, input),
    rollback: (versionId, input) => setActive("rolled-back", versionId, input),
    getActive,
    listLifecycle,
    getSnapshot,
  } satisfies AxisLearningStore["Service"];
});

export const layer = Layer.effect(AxisLearningStore, make);
