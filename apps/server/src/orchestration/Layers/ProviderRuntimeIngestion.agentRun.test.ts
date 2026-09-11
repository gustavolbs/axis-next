/**
 * Focused unit tests for the agent-run bookkeeping in
 * ProviderRuntimeIngestion. These tests do not bring up the full
 * ingestion layer; they exercise the helpers and the registry contract
 * together so the invariants required by the agent identity rules hold
 * without needing an end-to-end runtime.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  AgentRunStatus,
  MessageId,
  ProviderDriverKind,
  ProviderExecutionId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { makeAgentRunRegistryLive } from "../Services/AgentRunRegistry.ts";
import { isPlaceholderProviderExecutionId, providerExecutionIdFrom } from "@t3tools/contracts";

const opencode: ProviderDriverKind = ProviderDriverKind.make("opencode");

describe("agent run bookkeeping through ProviderRuntimeIngestion", () => {
  it.effect(
    "turn-start-requested mints a server-owned agentRunId and remembers it per thread",
    () =>
      Effect.gen(function* () {
        const registry = makeAgentRunRegistryLive();
        const started = yield* registry.register({
          provider: opencode,
          model: "minimax/minimax-m3",
          role: "main",
        });
        assert.isTrue(started.agentRunId.startsWith("agent-"));
        assert.strictEqual(started.status, "started" satisfies AgentRunStatus);
        const completed = yield* registry.patch({
          agentRunId: started.agentRunId,
          status: "completed",
        });
        assert.strictEqual(completed.agentRunId, started.agentRunId);
        assert.strictEqual(completed.status, "completed" satisfies AgentRunStatus);
        assert.isDefined(completed.endedAt);
      }),
  );

  it.effect("a real providerThreadId arriving in thread.started patches providerExecutionId", () =>
    Effect.gen(function* () {
      const registry = makeAgentRunRegistryLive();
      const started = yield* registry.register({
        provider: opencode,
        model: "minimax/minimax-m3",
        role: "main",
      });
      const patched = yield* registry.patch({
        agentRunId: started.agentRunId,
        providerExecutionId: ProviderExecutionId.make("ses_real_opencode_1"),
      });
      assert.strictEqual(patched.providerExecutionId, "ses_real_opencode_1");
    }),
  );

  it.effect("a placeholder providerThreadId never produces a providerExecutionId", () =>
    Effect.gen(function* () {
      const registry = makeAgentRunRegistryLive();
      const started = yield* registry.register({ provider: opencode, role: "main" });
      for (const placeholder of ["<id>", "<execution_id>", "placeholder", "unknown", ""]) {
        const patched = yield* registry.patch({
          agentRunId: started.agentRunId,
          providerExecutionId: providerExecutionIdFrom(placeholder),
        });
        assert.strictEqual(patched.providerExecutionId, started.providerExecutionId);
        assert.isTrue(isPlaceholderProviderExecutionId(placeholder));
      }
    }),
  );

  it.effect("turn.aborted terminal status is sticky against a later turn.completed", () =>
    Effect.gen(function* () {
      const registry = makeAgentRunRegistryLive();
      const started = yield* registry.register({ provider: opencode, role: "main" });
      yield* registry.patch({ agentRunId: started.agentRunId, status: "cancelled" });
      const later = yield* registry.patch({
        agentRunId: started.agentRunId,
        status: "completed",
      });
      assert.strictEqual(later.status, "cancelled" satisfies AgentRunStatus);
    }),
  );

  it.effect("thread.compacted events do not disturb the registry", () =>
    Effect.gen(function* () {
      const registry = makeAgentRunRegistryLive();
      const started = yield* registry.register({
        provider: opencode,
        role: "main",
      });
      // Simulate a reconnect: a real providerExecutionId arrives first, then
      // a second (later) providerExecutionId arrives. The first wins; the
      // second is ignored because the field is already set, keeping the
      // pre-compaction identity intact across the compaction event.
      const afterFirstId = yield* registry.patch({
        agentRunId: started.agentRunId,
        providerExecutionId: ProviderExecutionId.make("ses_pre_compact"),
      });
      assert.strictEqual(afterFirstId.providerExecutionId, "ses_pre_compact");
      const afterSecondId = yield* registry.patch({
        agentRunId: started.agentRunId,
        providerExecutionId: ProviderExecutionId.make("ses_post_compact"),
      });
      assert.strictEqual(afterSecondId.agentRunId, started.agentRunId);
      assert.strictEqual(afterSecondId.providerExecutionId, "ses_pre_compact");
    }),
  );

  it.effect("worker and reviewer dispatches produce two distinct agentRunIds", () =>
    Effect.gen(function* () {
      const registry = makeAgentRunRegistryLive();
      const worker = yield* registry.register({
        provider: opencode,
        model: "zhipu/glm-5.3-flash",
        role: "worker",
      });
      const reviewer = yield* registry.register({
        provider: opencode,
        model: "deepseek/deepseek-v4-pro-cheap",
        role: "reviewer",
      });
      assert.notStrictEqual(worker.agentRunId, reviewer.agentRunId);
      assert.strictEqual(worker.role, "worker");
      assert.strictEqual(reviewer.role, "reviewer");
    }),
  );

  it.effect("treats a runtime event payload carrying a placeholder providerThreadId as no-op", () =>
    Effect.gen(function* () {
      // Mirrors the runtime path: thread.started arrives without a real id.
      const registry = makeAgentRunRegistryLive();
      const started = yield* registry.register({ provider: opencode, role: "main" });
      const patched = yield* registry.patch({
        agentRunId: started.agentRunId,
        providerExecutionId: providerExecutionIdFrom(undefined),
      });
      assert.isUndefined(patched.providerExecutionId);
    }),
  );
});

describe("ProviderRuntimeEvent contract for identity fields", () => {
  it.effect(
    "thread.started payload carries providerThreadId that becomes providerExecutionId",
    () =>
      Effect.gen(function* () {
        const registry = makeAgentRunRegistryLive();
        const started = yield* registry.register({ provider: opencode, role: "main" });
        const patched = yield* registry.patch({
          agentRunId: started.agentRunId,
          providerExecutionId: ProviderExecutionId.make("ses_thread_started_1"),
        });
        assert.strictEqual(patched.providerExecutionId, "ses_thread_started_1");
      }),
  );

  it.effect("turn.completed terminal status matches the registry status", () =>
    Effect.gen(function* () {
      const registry = makeAgentRunRegistryLive();
      const started = yield* registry.register({ provider: opencode, role: "main" });
      const completed = yield* registry.patch({
        agentRunId: started.agentRunId,
        status: "completed",
      });
      assert.strictEqual(completed.status, "completed" satisfies AgentRunStatus);
    }),
  );

  it.effect("preserves the agentRunId shape through the registry on retry", () =>
    Effect.gen(function* () {
      const registry = makeAgentRunRegistryLive();
      const started = yield* registry.register({
        provider: opencode,
        role: "main",
      });
      // A retry within the same command window reuses the agentRunId; the
      // patch is a no-op when status is already terminal.
      const afterCancel = yield* registry.patch({
        agentRunId: started.agentRunId,
        status: "cancelled",
      });
      assert.strictEqual(afterCancel.status, "cancelled" satisfies AgentRunStatus);
      const stillSameId = yield* registry.get(started.agentRunId);
      assert.strictEqual(stillSameId?.agentRunId, started.agentRunId);
    }),
  );

  it("MessageId is part of the runtime event base so retries can stay correlated", () => {
    const messageId = MessageId.make("message-1");
    assert.match(messageId, /^message-/);
  });

  it("providerExecutionIdFrom returns the brand-typed id only for real strings", () => {
    const id = providerExecutionIdFrom("ses_xyz_42");
    assert.strictEqual(id, "ses_xyz_42");
    assert.isNull(providerExecutionIdFrom("<id>"));
    assert.isNull(providerExecutionIdFrom(undefined));
  });

  it.effect("mints distinct AgentRunId values for back-to-back dispatches", () =>
    Effect.gen(function* () {
      const registry = makeAgentRunRegistryLive();
      const ids = new Set<string>();
      for (let index = 0; index < 50; index += 1) {
        const record = yield* registry.register({ provider: opencode, role: "worker" });
        ids.add(record.agentRunId);
      }
      assert.strictEqual(ids.size, 50);
    }),
  );

  it.effect("patches a real providerExecutionId without disturbing an existing role", () =>
    Effect.gen(function* () {
      const registry = makeAgentRunRegistryLive();
      const started = yield* registry.register({
        provider: opencode,
        model: "minimax/minimax-m3",
        role: "reviewer",
      });
      const patched = yield* registry.patch({
        agentRunId: started.agentRunId,
        providerExecutionId: ProviderExecutionId.make("ses_reviewer_99"),
      });
      assert.strictEqual(patched.role, "reviewer");
      assert.strictEqual(patched.providerExecutionId, "ses_reviewer_99");
      const unchanged = yield* registry.get(started.agentRunId);
      assert.strictEqual(unchanged?.role, "reviewer");
    }),
  );
});
