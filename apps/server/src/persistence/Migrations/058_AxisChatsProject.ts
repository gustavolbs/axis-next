// @effect-diagnostics nodeBuiltinImport:off - pure native path resolution, shared with migration payloads.
import * as NodePath from "node:path";
import { ProjectCreatedPayload } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { AXIS_CHATS_PROJECT_ID, axisChatsDirectory } from "../../axis/chats/AxisChats.ts";

const encodeProject = Schema.encodeEffect(Schema.fromJsonString(ProjectCreatedPayload));

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const chats = yield* sql<{ thread_id: string }>`
    SELECT thread_id FROM projection_threads WHERE project_id IS NULL
    UNION SELECT stream_id FROM orchestration_events
      WHERE aggregate_kind = 'thread' AND event_type = 'thread.created'
        AND json_extract(payload_json, '$.projectId') IS NULL
  `;
  if (chats.length === 0) return;
  const databases = yield* sql<{ name: string; file: string }>`PRAGMA database_list`;
  const databaseFile = databases.find((database) => database.name === "main")?.file;
  const chatsDirectory = axisChatsDirectory(
    databaseFile ? NodePath.dirname(databaseFile) : process.cwd(),
  );
  const now = DateTime.formatIso(yield* DateTime.now);
  const payload = yield* encodeProject({
    projectId: AXIS_CHATS_PROJECT_ID,
    title: "Chats",
    workspaceRoot: chatsDirectory,
    defaultModelSelection: null,
    scripts: [],
    createdAt: now,
    updatedAt: now,
  });
  yield* sql`
    INSERT INTO orchestration_events (
      event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
      command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
    ) VALUES (
      'axis-chats-project:058', 'project', ${AXIS_CHATS_PROJECT_ID}, 1,
      'project.created', ${now}, NULL, NULL, NULL, 'system', ${payload}, '{}'
    )
  `;

  for (const chat of chats) {
    // Older clients require a project even when replaying thread.created.
    // Keep identifiers, message events, archive state and provider resume cursors.
    yield* sql`UPDATE orchestration_events
      SET payload_json = json_set(payload_json, '$.projectId', ${AXIS_CHATS_PROJECT_ID},
        '$.branch', NULL, '$.worktreePath', NULL, '$.runtimeMode', 'approval-required')
      WHERE aggregate_kind = 'thread' AND stream_id = ${chat.thread_id}
        AND event_type = 'thread.created'`;
    yield* sql`UPDATE orchestration_events
      SET payload_json = json_set(payload_json, '$.runtimeMode', 'approval-required')
      WHERE aggregate_kind = 'thread' AND stream_id = ${chat.thread_id}
        AND event_type IN ('thread.runtime-mode-set', 'thread.turn-start-requested')`;
    yield* sql`UPDATE orchestration_events
      SET payload_json = json_set(payload_json, '$.session.runtimeMode', 'approval-required')
      WHERE aggregate_kind = 'thread' AND stream_id = ${chat.thread_id}
        AND event_type = 'thread.session-set' AND json_type(payload_json, '$.session') = 'object'`;
    yield* sql`UPDATE projection_threads
      SET project_id = ${AXIS_CHATS_PROJECT_ID}, branch = NULL, worktree_path = NULL,
        runtime_mode = 'approval-required'
      WHERE thread_id = ${chat.thread_id}`;
    yield* sql`UPDATE projection_thread_sessions SET runtime_mode = 'approval-required'
      WHERE thread_id = ${chat.thread_id}`;
    yield* sql`UPDATE provider_session_runtime SET runtime_mode = 'approval-required',
      runtime_payload_json = json_set(COALESCE(runtime_payload_json, '{}'), '$.axisChat', json('true'), '$.cwd', ${NodePath.join(chatsDirectory, encodeURIComponent(chat.thread_id))})
      WHERE thread_id = ${chat.thread_id}`;
    // Reconnecting clients need a thread shell refresh even when their cursor
    // already passed the historical creation event before this migration.
    yield* sql`INSERT INTO orchestration_events (
      event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
      command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
    ) VALUES (
      ${`axis-chats-refresh:058:${chat.thread_id}`}, 'thread', ${chat.thread_id},
      (SELECT COALESCE(MAX(stream_version), 0) + 1 FROM orchestration_events WHERE aggregate_kind = 'thread' AND stream_id = ${chat.thread_id}),
      'thread.meta-updated', ${now}, NULL, NULL, NULL, 'system',
      json_object('threadId', ${chat.thread_id}, 'branch', NULL, 'worktreePath', NULL,
        'updatedAt', COALESCE((SELECT updated_at FROM projection_threads WHERE thread_id = ${chat.thread_id}), ${now})), '{}'
    )`;
  }
});
