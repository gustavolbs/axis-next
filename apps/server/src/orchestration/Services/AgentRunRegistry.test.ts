import { assert, describe, it } from "@effect/vitest";
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

describe("AgentRunRegistry", () => {
  it.effect("returns a server-minted agentRunId on register", () =>
    Effect.gen(function* () {
      const registry = makeAgentRunRegistryLive();
      const record = yield* registry.register({
        provider,
        model: "minimax/minimax-m3",
        role: "main",
      });
      assert.isTrue(record.agentRunId.startsWith("agent-"));
      assert.isUndefined(record.providerExecutionId);
      assert.strictEqual(record.status, "started" satisfies AgentRunStatus);
      assert.strictEqual(record.role, "main" satisfies AgentRunRole);
    }),
  );

  it.effect("does not back-fill a provider execution id from placeholder strings", () =>
    Effect.gen(function* () {
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
        const record = yield* registry.register({
          provider,
          model: "zhipu/glm-5.3-flash",
          role: "worker",
          providerExecutionId: placeholder,
        });
        assert.isUndefined(record.providerExecutionId);
      }
    }),
  );

  it.effect("accepts a real provider execution id when the provider supplies one", () =>
    Effect.gen(function* () {
      const registry = makeAgentRunRegistryLive();
      const record = yield* registry.register({
        provider,
        model: "minimax/minimax-m3",
        role: "worker",
        providerExecutionId: ProviderExecutionId.make("ses_real_1"),
      });
      assert.strictEqual(record.providerExecutionId, "ses_real_1");
    }),
  );

  it.effect("keeps a stable agentRunId across a started → completed transition", () =>
    Effect.gen(function* () {
      const registry = makeAgentRunRegistryLive();
      const started = yield* registry.register({
        provider,
        model: "minimax/minimax-m3",
        role: "main",
      });
      const completed = yield* registry.patch({
        agentRunId: started.agentRunId,
        status: "completed",
      });
      assert.strictEqual(completed.agentRunId, started.agentRunId);
      assert.strictEqual(completed.status, "completed" satisfies AgentRunStatus);
      assert.isDefined(completed.endedAt);
    }),
  );

  it.effect("patches a real provider execution id onto an existing record without re-minting", () =>
    Effect.gen(function* () {
      const registry = makeAgentRunRegistryLive();
      const started = yield* registry.register({
        provider,
        model: "zhipu/glm-5.3-flash",
        role: "worker",
      });
      const patched = yield* registry.patch({
        agentRunId: started.agentRunId,
        providerExecutionId: ProviderExecutionId.make("ses_late_2"),
      });
      assert.strictEqual(patched.agentRunId, started.agentRunId);
      assert.strictEqual(patched.providerExecutionId, "ses_late_2");
      const fetched = yield* registry.get(started.agentRunId);
      assert.strictEqual(fetched?.providerExecutionId, "ses_late_2");
    }),
  );

  it.effect("issues distinct agentRunIds for worker and reviewer dispatches", () =>
    Effect.gen(function* () {
      const registry = makeAgentRunRegistryLive();
      const worker = yield* registry.register({
        provider,
        model: "zhipu/glm-5.3-flash",
        role: "worker",
      });
      const reviewer = yield* registry.register({
        provider,
        model: "deepseek/deepseek-v4-pro-cheap",
        role: "reviewer",
      });
      assert.notStrictEqual(worker.agentRunId, reviewer.agentRunId);
      assert.strictEqual(worker.role, "worker" satisfies AgentRunRole);
      assert.strictEqual(reviewer.role, "reviewer" satisfies AgentRunRole);
    }),
  );

  it.effect("two agents dispatched with the same model still receive distinct agentRunIds", () =>
    Effect.gen(function* () {
      const registry = makeAgentRunRegistryLive();
      const a = yield* registry.register({
        provider,
        model: "zhipu/glm-5.3-flash",
        role: "worker",
      });
      const b = yield* registry.register({
        provider,
        model: "zhipu/glm-5.3-flash",
        role: "worker",
      });
      assert.notStrictEqual(a.agentRunId, b.agentRunId);
    }),
  );

  it.effect("findByProviderExecutionId returns the existing record after a late patch", () =>
    Effect.gen(function* () {
      const registry = makeAgentRunRegistryLive();
      const created = yield* registry.register({
        provider,
        role: "worker",
      });
      yield* registry.patch({
        agentRunId: created.agentRunId,
        providerExecutionId: ProviderExecutionId.make("ses_find_1"),
      });
      const found = yield* registry.findByProviderExecutionId(
        ProviderExecutionId.make("ses_find_1"),
      );
      assert.strictEqual(found?.agentRunId, created.agentRunId);
    }),
  );

  it.effect(
    "findOrCreateByProviderExecutionId reuses an existing run for the same provider id",
    () =>
      Effect.gen(function* () {
        const registry = makeAgentRunRegistryLive();
        const first = yield* registry.findOrCreateByProviderExecutionId({
          providerExecutionId: ProviderExecutionId.make("ses_reuse_1"),
          provider,
          model: "minimax/minimax-m3",
          role: "worker",
        });
        const second = yield* registry.findOrCreateByProviderExecutionId({
          providerExecutionId: ProviderExecutionId.make("ses_reuse_1"),
          provider,
          model: "minimax/minimax-m3",
          role: "worker",
        });
        assert.strictEqual(first.agentRunId, second.agentRunId);
      }),
  );

  it.effect("cancel and retry reuse the same agentRunId without creating a new one", () =>
    Effect.gen(function* () {
      const registry = makeAgentRunRegistryLive();
      const started = yield* registry.register({
        provider,
        role: "worker",
      });
      const cancelled = yield* registry.patch({
        agentRunId: started.agentRunId,
        status: "cancelled",
      });
      assert.strictEqual(cancelled.status, "cancelled" satisfies AgentRunStatus);

      // A retry within the same command window re-patches status without
      // minting a new id; here we use the started → completed path on the
      // same id to demonstrate that the registry never re-mints.
      const retry = yield* registry.patch({
        agentRunId: started.agentRunId,
        status: "started",
      });
      assert.strictEqual(retry.agentRunId, started.agentRunId);
      assert.strictEqual(retry.status, "cancelled" satisfies AgentRunStatus);
    }),
  );

  it.effect("terminal status is sticky and not overwritten by a later event", () =>
    Effect.gen(function* () {
      const registry = makeAgentRunRegistryLive();
      const started = yield* registry.register({
        provider,
        role: "worker",
      });
      yield* registry.patch({
        agentRunId: started.agentRunId,
        status: "completed",
      });
      const late = yield* registry.patch({
        agentRunId: started.agentRunId,
        status: "cancelled",
      });
      assert.strictEqual(late.status, "completed" satisfies AgentRunStatus);
    }),
  );

  it.effect("patch on an unknown agentRunId fails with AgentRunNotFoundError", () =>
    Effect.gen(function* () {
      const registry = makeAgentRunRegistryLive();
      const result = yield* registry
        .patch({
          agentRunId: AgentRunId.make("agent-does-not-exist"),
          status: "completed",
        })
        .pipe(Effect.flip);
      assert.instanceOf(result, AgentRunNotFoundError);
    }),
  );

  it.effect("list exposes every record registered", () =>
    Effect.gen(function* () {
      const registry = makeAgentRunRegistryLive();
      const r1 = yield* registry.register({ provider, role: "worker" });
      const r2 = yield* registry.register({ provider, role: "reviewer" });
      const all = yield* registry.list();
      assert.strictEqual(all.length, 2);
      assert.deepStrictEqual(
        all.map((record) => record.agentRunId),
        [r1.agentRunId, r2.agentRunId],
      );
    }),
  );

  it.effect("parent linkage is preserved across patches", () =>
    Effect.gen(function* () {
      const registry = makeAgentRunRegistryLive();
      const parent = yield* registry.register({ provider, role: "main" });
      const child = yield* registry.register({
        provider,
        role: "subagent",
        parentRunId: parent.agentRunId,
      });
      assert.strictEqual(child.parentRunId, parent.agentRunId);
      const patched = yield* registry.patch({
        agentRunId: child.agentRunId,
        providerExecutionId: ProviderExecutionId.make("ses_child_3"),
      });
      assert.strictEqual(patched.parentRunId, parent.agentRunId);
      assert.strictEqual(patched.providerExecutionId, "ses_child_3");
    }),
  );

  it.effect("ignores a duplicate provider execution id pointing at a different agentRunId", () =>
    Effect.gen(function* () {
      const registry = makeAgentRunRegistryLive();
      const first = yield* registry.register({
        provider,
        role: "worker",
        providerExecutionId: ProviderExecutionId.make("ses_unique"),
      });
      const second = yield* registry.register({
        provider,
        role: "worker",
        providerExecutionId: ProviderExecutionId.make("ses_unique"),
      });
      assert.strictEqual(second.agentRunId, first.agentRunId);
      const fetched = yield* registry.get(first.agentRunId);
      assert.strictEqual(fetched?.agentRunId, first.agentRunId);
    }),
  );

  it.effect("mints 50 distinct agentRunIds in a tight loop", () =>
    Effect.gen(function* () {
      const registry = makeAgentRunRegistryLive();
      const ids = new Set<string>();
      for (let index = 0; index < 50; index += 1) {
        const record = yield* registry.register({ provider, role: "worker" });
        ids.add(record.agentRunId);
      }
      assert.strictEqual(ids.size, 50);
    }),
  );
});
