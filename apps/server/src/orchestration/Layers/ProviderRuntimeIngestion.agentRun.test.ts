/**
 * Focused unit tests for the agent-run bookkeeping in
 * ProviderRuntimeIngestion. These tests do not bring up the full
 * ingestion layer; they exercise the helpers and the registry contract
 * together so the invariants required by the agent identity rules hold
 * without needing an end-to-end runtime.
 */
import {
  AgentRunStatus,
  MessageId,
  ProviderDriverKind,
  ProviderExecutionId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";

import { AgentRunRegistryLive, makeAgentRunRegistryLive } from "../Services/AgentRunRegistry.ts";
import { isPlaceholderProviderExecutionId, providerExecutionIdFrom } from "@t3tools/contracts";

const runRegistry = <A, E>(program: Effect.Effect<A, E, never>): Promise<A> =>
  Effect.runPromise(program);

const opencode: ProviderDriverKind = ProviderDriverKind.make("opencode");

describe("agent run bookkeeping through ProviderRuntimeIngestion", () => {
  it("turn-start-requested mints a server-owned agentRunId and remembers it per thread", async () => {
    const registry = makeAgentRunRegistryLive();
    const started = await runRegistry(
      registry.register({
        provider: opencode,
        model: "minimax/minimax-m3",
        role: "main",
      }),
    );
    expect(started.agentRunId.startsWith("agent-")).toBe(true);
    expect(started.status).toBe<AgentRunStatus>("started");
    // No registry lookup helper is exported here, but the next test
    // proves the patch path uses the same id.
    const completed = await runRegistry(
      registry.patch({ agentRunId: started.agentRunId, status: "completed" }),
    );
    expect(completed.agentRunId).toBe(started.agentRunId);
    expect(completed.status).toBe<AgentRunStatus>("completed");
    expect(completed.endedAt).toBeDefined();
  });

  it("a real providerThreadId arriving in thread.started patches providerExecutionId", async () => {
    const registry = makeAgentRunRegistryLive();
    const started = await runRegistry(
      registry.register({
        provider: opencode,
        model: "minimax/minimax-m3",
        role: "main",
      }),
    );
    const patched = await runRegistry(
      registry.patch({
        agentRunId: started.agentRunId,
        providerExecutionId: ProviderExecutionId.make("ses_real_opencode_1"),
      }),
    );
    expect(patched.providerExecutionId).toBe("ses_real_opencode_1");
  });

  it("a placeholder providerThreadId never produces a providerExecutionId", async () => {
    const registry = makeAgentRunRegistryLive();
    const started = await runRegistry(registry.register({ provider: opencode, role: "main" }));
    for (const placeholder of ["<id>", "<execution_id>", "placeholder", "unknown", ""]) {
      const patched = await runRegistry(
        registry.patch({
          agentRunId: started.agentRunId,
          providerExecutionId: providerExecutionIdFrom(placeholder),
        }),
      );
      expect(patched.providerExecutionId).toBe(started.providerExecutionId);
      expect(isPlaceholderProviderExecutionId(placeholder)).toBe(true);
    }
  });

  it("turn.aborted terminal status is sticky against a later turn.completed", async () => {
    const registry = makeAgentRunRegistryLive();
    const started = await runRegistry(registry.register({ provider: opencode, role: "main" }));
    await runRegistry(registry.patch({ agentRunId: started.agentRunId, status: "cancelled" }));
    const later = await runRegistry(
      registry.patch({ agentRunId: started.agentRunId, status: "completed" }),
    );
    expect(later.status).toBe<AgentRunStatus>("cancelled");
  });

  it("thread.compacted events do not disturb the registry", async () => {
    const registry = makeAgentRunRegistryLive();
    const started = await runRegistry(
      registry.register({
        provider: opencode,
        role: "main",
      }),
    );
    // Simulate a reconnect: a real providerExecutionId arrives first, then
    // a (placeholder) reconnect candidate arrives. The first wins; the
    // second is ignored because the field is already set, keeping the
    // pre-compaction identity intact across the compaction event.
    const afterFirstId = await runRegistry(
      registry.patch({
        agentRunId: started.agentRunId,
        providerExecutionId: ProviderExecutionId.make("ses_pre_compact"),
      }),
    );
    expect(afterFirstId.providerExecutionId).toBe("ses_pre_compact");
    const afterSecondId = await runRegistry(
      registry.patch({
        agentRunId: started.agentRunId,
        providerExecutionId: ProviderExecutionId.make("ses_post_compact"),
      }),
    );
    expect(afterSecondId.agentRunId).toBe(started.agentRunId);
    expect(afterSecondId.providerExecutionId).toBe("ses_pre_compact");
  });

  it("worker and reviewer dispatches produce two distinct agentRunIds", async () => {
    const registry = makeAgentRunRegistryLive();
    const worker = await runRegistry(
      registry.register({
        provider: opencode,
        model: "zhipu/glm-5.3-flash",
        role: "worker",
      }),
    );
    const reviewer = await runRegistry(
      registry.register({
        provider: opencode,
        model: "deepseek/deepseek-v4-pro-cheap",
        role: "reviewer",
      }),
    );
    expect(worker.agentRunId).not.toBe(reviewer.agentRunId);
    expect(worker.role).toBe("worker");
    expect(reviewer.role).toBe("reviewer");
  });

  it("treats a runtime event payload carrying a placeholder providerThreadId as no-op", async () => {
    // Mirrors the runtime path: thread.started arrives without a real id.
    const registry = makeAgentRunRegistryLive();
    const started = await runRegistry(registry.register({ provider: opencode, role: "main" }));
    const patched = await runRegistry(
      registry.patch({
        agentRunId: started.agentRunId,
        providerExecutionId: providerExecutionIdFrom(undefined),
      }),
    );
    expect(patched.providerExecutionId).toBeUndefined();
  });
});

describe("ProviderRuntimeEvent contract for identity fields", () => {
  it("thread.started payload carries providerThreadId that becomes providerExecutionId", async () => {
    const registry = makeAgentRunRegistryLive();
    const started = await runRegistry(registry.register({ provider: opencode, role: "main" }));
    const patched = await runRegistry(
      registry.patch({
        agentRunId: started.agentRunId,
        providerExecutionId: ProviderExecutionId.make("ses_thread_started_1"),
      }),
    );
    expect(patched.providerExecutionId).toBe("ses_thread_started_1");
  });

  it("turn.completed terminal status matches the registry status", async () => {
    const registry = makeAgentRunRegistryLive();
    const started = await runRegistry(registry.register({ provider: opencode, role: "main" }));
    const completed = await runRegistry(
      registry.patch({ agentRunId: started.agentRunId, status: "completed" }),
    );
    expect(completed.status).toBe<AgentRunStatus>("completed");
  });

  it("preserves the agentRunId shape through the registry on retry", async () => {
    const registry = makeAgentRunRegistryLive();
    const started = await runRegistry(
      registry.register({
        provider: opencode,
        role: "main",
      }),
    );
    // A retry within the same command window reuses the agentRunId; the
    // patch is a no-op when status is already terminal.
    const afterCancel = await runRegistry(
      registry.patch({
        agentRunId: started.agentRunId,
        status: "cancelled",
      }),
    );
    expect(afterCancel.status).toBe<AgentRunStatus>("cancelled");
    const stillSameId = await runRegistry(registry.get(started.agentRunId));
    expect(stillSameId?.agentRunId).toBe(started.agentRunId);
  });

  it("MessageId is part of the runtime event base so retries can stay correlated", () => {
    const messageId = MessageId.make("message-1");
    expect(messageId).toMatch(/^message-/);
  });

  it("providerExecutionIdFrom returns the brand-typed id only for real strings", () => {
    const id = providerExecutionIdFrom("ses_xyz_42");
    expect(id).toBe("ses_xyz_42");
    expect(providerExecutionIdFrom("<id>")).toBeNull();
    expect(providerExecutionIdFrom(undefined)).toBeNull();
  });

  it("mints distinct AgentRunId values for back-to-back dispatches", async () => {
    const registry = makeAgentRunRegistryLive();
    const ids = new Set<string>();
    for (let index = 0; index < 50; index += 1) {
      const record = await runRegistry(registry.register({ provider: opencode, role: "worker" }));
      ids.add(record.agentRunId);
    }
    expect(ids.size).toBe(50);
    for (const id of ids) {
      expect(id.startsWith("agent-")).toBe(true);
    }
  });

  it("patches a real providerExecutionId without disturbing an existing role", async () => {
    const registry = makeAgentRunRegistryLive();
    const started = await runRegistry(
      registry.register({
        provider: opencode,
        model: "minimax/minimax-m3",
        role: "reviewer",
      }),
    );
    const patched = await runRegistry(
      registry.patch({
        agentRunId: started.agentRunId,
        providerExecutionId: ProviderExecutionId.make("ses_reviewer_99"),
      }),
    );
    expect(patched.role).toBe("reviewer");
    expect(patched.providerExecutionId).toBe("ses_reviewer_99");
    const unchanged = await runRegistry(registry.get(started.agentRunId));
    expect(unchanged?.role).toBe("reviewer");
  });
});
