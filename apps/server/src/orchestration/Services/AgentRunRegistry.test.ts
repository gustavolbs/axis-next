import { describe, expect, it } from "vite-plus/test";

import {
  AgentRunId,
  AgentRunRole,
  AgentRunStatus,
  ProviderDriverKind,
  ProviderExecutionId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { AgentRunNotFoundError, makeAgentRunRegistryLive } from "./AgentRunRegistry.ts";

const provider: ProviderDriverKind = ProviderDriverKind.make("opencode");

const runRegistry = <A, E>(program: Effect.Effect<A, E, never>): Promise<A> =>
  Effect.runPromise(program);

describe("AgentRunRegistry", () => {
  it("returns a server-minted agentRunId on register", async () => {
    const registry = makeAgentRunRegistryLive();
    const record = await runRegistry(
      registry.register({
        provider,
        model: "minimax/minimax-m3",
        role: "main",
      }),
    );
    expect(record.agentRunId.startsWith("agent-")).toBe(true);
    expect(record.providerExecutionId).toBeUndefined();
    expect(record.status).toBe<AgentRunStatus>("started");
    expect(record.role).toBe<AgentRunRole>("main");
  });

  it("does not back-fill a provider execution id from placeholder strings", async () => {
    const registry = makeAgentRunRegistryLive();
    for (const placeholder of [
      "<id>",
      "<execution_id>",
      "<run_id>",
      "placeholder",
      "unknown",
      "synthetic",
      "",
    ]) {
      const record = await runRegistry(
        registry.register({
          provider,
          model: "zhipu/glm-5.3-flash",
          role: "worker",
          providerExecutionId: placeholder,
        }),
      );
      expect(record.providerExecutionId).toBeUndefined();
    }
  });

  it("accepts a real provider execution id when the provider supplies one", async () => {
    const registry = makeAgentRunRegistryLive();
    const record = await runRegistry(
      registry.register({
        provider,
        model: "minimax/minimax-m3",
        role: "worker",
        providerExecutionId: ProviderExecutionId.make("ses_real_1"),
      }),
    );
    expect(record.providerExecutionId).toBe("ses_real_1");
  });

  it("keeps a stable agentRunId across a started → completed transition", async () => {
    const registry = makeAgentRunRegistryLive();
    const started = await runRegistry(
      registry.register({
        provider,
        model: "minimax/minimax-m3",
        role: "main",
      }),
    );
    const completed = await runRegistry(
      registry.patch({ agentRunId: started.agentRunId, status: "completed" }),
    );
    expect(completed.agentRunId).toBe(started.agentRunId);
    expect(completed.status).toBe<AgentRunStatus>("completed");
    expect(completed.endedAt).toBeDefined();
  });

  it("patches a real provider execution id onto an existing record without re-minting", async () => {
    const registry = makeAgentRunRegistryLive();
    const started = await runRegistry(
      registry.register({
        provider,
        model: "zhipu/glm-5.3-flash",
        role: "worker",
      }),
    );
    const patched = await runRegistry(
      registry.patch({
        agentRunId: started.agentRunId,
        providerExecutionId: ProviderExecutionId.make("ses_late_2"),
      }),
    );
    expect(patched.agentRunId).toBe(started.agentRunId);
    expect(patched.providerExecutionId).toBe("ses_late_2");
    const fetched = await runRegistry(registry.get(started.agentRunId));
    expect(fetched?.providerExecutionId).toBe("ses_late_2");
  });

  it("issues distinct agentRunIds for worker and reviewer dispatches", async () => {
    const registry = makeAgentRunRegistryLive();
    const worker = await runRegistry(
      registry.register({
        provider,
        model: "zhipu/glm-5.3-flash",
        role: "worker",
      }),
    );
    const reviewer = await runRegistry(
      registry.register({
        provider,
        model: "deepseek/deepseek-v4-pro-cheap",
        role: "reviewer",
      }),
    );
    expect(worker.agentRunId).not.toBe(reviewer.agentRunId);
    expect(worker.role).toBe<AgentRunRole>("worker");
    expect(reviewer.role).toBe<AgentRunRole>("reviewer");
  });

  it("two agents dispatched with the same model still receive distinct agentRunIds", async () => {
    const registry = makeAgentRunRegistryLive();
    const a = await runRegistry(
      registry.register({
        provider,
        model: "zhipu/glm-5.3-flash",
        role: "worker",
      }),
    );
    const b = await runRegistry(
      registry.register({
        provider,
        model: "zhipu/glm-5.3-flash",
        role: "worker",
      }),
    );
    expect(a.agentRunId).not.toBe(b.agentRunId);
  });

  it("findByProviderExecutionId returns the existing record after a late patch", async () => {
    const registry = makeAgentRunRegistryLive();
    const created = await runRegistry(
      registry.register({
        provider,
        role: "worker",
      }),
    );
    await runRegistry(
      registry.patch({
        agentRunId: created.agentRunId,
        providerExecutionId: ProviderExecutionId.make("ses_find_1"),
      }),
    );
    const found = await runRegistry(
      registry.findByProviderExecutionId(ProviderExecutionId.make("ses_find_1")),
    );
    expect(found?.agentRunId).toBe(created.agentRunId);
  });

  it("findOrCreateByProviderExecutionId reuses an existing run for the same provider id", async () => {
    const registry = makeAgentRunRegistryLive();
    const first = await runRegistry(
      registry.findOrCreateByProviderExecutionId({
        providerExecutionId: ProviderExecutionId.make("ses_reuse_1"),
        provider,
        model: "minimax/minimax-m3",
        role: "worker",
      }),
    );
    const second = await runRegistry(
      registry.findOrCreateByProviderExecutionId({
        providerExecutionId: ProviderExecutionId.make("ses_reuse_1"),
        provider,
        model: "minimax/minimax-m3",
        role: "worker",
      }),
    );
    expect(first.agentRunId).toBe(second.agentRunId);
  });

  it("cancel and retry reuse the same agentRunId without creating a new one", async () => {
    const registry = makeAgentRunRegistryLive();
    const started = await runRegistry(
      registry.register({
        provider,
        role: "worker",
      }),
    );
    const cancelled = await runRegistry(
      registry.patch({
        agentRunId: started.agentRunId,
        status: "cancelled",
      }),
    );
    expect(cancelled.status).toBe<AgentRunStatus>("cancelled");

    // A retry within the same command window re-patches status without
    // minting a new id; here we use the started → completed path on the
    // same id to demonstrate that the registry never re-mints.
    const retry = await runRegistry(
      registry.patch({
        agentRunId: started.agentRunId,
        status: "started",
      }),
    );
    expect(retry.agentRunId).toBe(started.agentRunId);
    expect(retry.status).toBe<AgentRunStatus>("cancelled");
  });

  it("terminal status is sticky and not overwritten by a later event", async () => {
    const registry = makeAgentRunRegistryLive();
    const started = await runRegistry(
      registry.register({
        provider,
        role: "worker",
      }),
    );
    await runRegistry(
      registry.patch({
        agentRunId: started.agentRunId,
        status: "completed",
      }),
    );
    const late = await runRegistry(
      registry.patch({
        agentRunId: started.agentRunId,
        status: "cancelled",
      }),
    );
    expect(late.status).toBe<AgentRunStatus>("completed");
  });

  it("patch on an unknown agentRunId fails with AgentRunNotFoundError", async () => {
    const registry = makeAgentRunRegistryLive();
    const result = await Effect.runPromise(
      registry
        .patch({
          agentRunId: AgentRunId.make("agent-does-not-exist"),
          status: "completed",
        })
        .pipe(Effect.flip),
    );
    expect(result).toBeInstanceOf(AgentRunNotFoundError);
  });

  it("list exposes every record registered", async () => {
    const registry = makeAgentRunRegistryLive();
    const r1 = await runRegistry(registry.register({ provider, role: "worker" }));
    const r2 = await runRegistry(registry.register({ provider, role: "reviewer" }));
    const all = await runRegistry(registry.list());
    expect(all).toHaveLength(2);
    expect(all.map((record) => record.agentRunId)).toEqual([r1.agentRunId, r2.agentRunId]);
  });

  it("parent linkage is preserved across patches", async () => {
    const registry = makeAgentRunRegistryLive();
    const parent = await runRegistry(registry.register({ provider, role: "main" }));
    const child = await runRegistry(
      registry.register({
        provider,
        role: "subagent",
        parentRunId: parent.agentRunId,
      }),
    );
    expect(child.parentRunId).toBe(parent.agentRunId);
    const patched = await runRegistry(
      registry.patch({
        agentRunId: child.agentRunId,
        providerExecutionId: ProviderExecutionId.make("ses_child_3"),
      }),
    );
    expect(patched.parentRunId).toBe(parent.agentRunId);
    expect(patched.providerExecutionId).toBe("ses_child_3");
  });

  it("ignores a duplicate provider execution id pointing at a different agentRunId", async () => {
    const registry = makeAgentRunRegistryLive();
    const first = await runRegistry(
      registry.register({
        provider,
        role: "worker",
        providerExecutionId: ProviderExecutionId.make("ses_unique"),
      }),
    );
    const second = await runRegistry(
      registry.register({
        provider,
        role: "worker",
        providerExecutionId: ProviderExecutionId.make("ses_unique"),
      }),
    );
    expect(second.agentRunId).toBe(first.agentRunId);
    const fetched = await runRegistry(registry.get(first.agentRunId));
    expect(fetched?.agentRunId).toBe(first.agentRunId);
  });
});
