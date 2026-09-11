import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  AgentRunId,
  AgentRunIdentity,
  AgentRunRecord,
  AgentRunRole,
  AgentRunStatus,
  classifyTaskAgentKind,
  isPlaceholderProviderExecutionId,
  ProviderExecutionId,
  providerExecutionIdFrom,
  ProviderRuntimeEvent,
  type ProviderRuntimeEventType,
} from "./providerRuntime.ts";

const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);

describe("ProviderRuntimeEvent", () => {
  it("includes every runtime event in the public event type", () => {
    expectTypeOf<ProviderRuntimeEvent["type"]>().toEqualTypeOf<ProviderRuntimeEventType>();
  });

  it("requires input and output totals for complete turn usage", () => {
    const completeEvent = {
      type: "turn.completed",
      eventId: "event-complete-usage",
      provider: "codex",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        state: "completed",
        tokenUsage: {
          usageStatus: "complete",
          usageScope: "main_agent",
          hasSubagents: false,
        },
      },
    };

    expect(() => decodeRuntimeEvent(completeEvent)).toThrow();
    expect(
      decodeRuntimeEvent({
        ...completeEvent,
        payload: {
          ...completeEvent.payload,
          tokenUsage: {
            ...completeEvent.payload.tokenUsage,
            inputTokens: 10,
            outputTokens: 2,
          },
        },
      }).type,
    ).toBe("turn.completed");
    expect(
      decodeRuntimeEvent({
        ...completeEvent,
        payload: {
          ...completeEvent.payload,
          tokenUsage: {
            ...completeEvent.payload.tokenUsage,
            usageStatus: "partial",
          },
        },
      }).type,
    ).toBe("turn.completed");
  });

  it("accepts fork-provided driver kinds as branded slugs", () => {
    const parsed = decodeRuntimeEvent({
      type: "session.started",
      eventId: "event-ollama-session",
      provider: "ollama",
      providerInstanceId: "ollama_local",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      payload: {
        message: "started",
      },
    });

    expect(parsed.provider).toBe("ollama");
    expect(parsed.providerInstanceId).toBe("ollama_local");
  });

  it("accepts only normalized runtime failure kinds", () => {
    const base = {
      type: "runtime.error",
      eventId: "event-quota",
      provider: "codex",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      payload: {
        message: "Usage limit reached",
        class: "provider_error",
      },
    };

    const parsed = decodeRuntimeEvent({
      ...base,
      payload: { ...base.payload, failureKind: "quota-exhausted" },
    });
    expect(parsed.type === "runtime.error" && parsed.payload.failureKind).toBe("quota-exhausted");
    expect(() =>
      decodeRuntimeEvent({
        ...base,
        payload: { ...base.payload, failureKind: "rate-limited" },
      }),
    ).toThrow();
  });

  it("decodes turn.plan.updated for plan rendering", () => {
    const parsed = decodeRuntimeEvent({
      type: "turn.plan.updated",
      eventId: "event-1",
      provider: "claudeAgent",
      sessionId: "runtime-session-1",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        explanation: "Implement schema updates",
        plan: [
          { step: "Define event union", status: "completed" },
          { step: "Wire adapter mapping", status: "inProgress" },
        ],
      },
    });

    expect(parsed.type).toBe("turn.plan.updated");
    if (parsed.type !== "turn.plan.updated") {
      throw new Error("expected turn.plan.updated");
    }
    expect(parsed.payload.plan).toHaveLength(2);
    expect(parsed.payload.plan[1]?.status).toBe("inProgress");
  });

  it("decodes proposed-plan completion events", () => {
    const parsed = decodeRuntimeEvent({
      type: "turn.proposed.completed",
      eventId: "event-proposed-plan-1",
      provider: "codex",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        planMarkdown: "# Ship it",
      },
    });

    expect(parsed.type).toBe("turn.proposed.completed");
    if (parsed.type !== "turn.proposed.completed") {
      throw new Error("expected turn.proposed.completed");
    }
    expect(parsed.payload.planMarkdown).toBe("# Ship it");
  });

  it("decodes user-input.requested with structured questions", () => {
    const parsed = decodeRuntimeEvent({
      type: "user-input.requested",
      eventId: "event-2",
      provider: "claudeAgent",
      sessionId: "runtime-session-2",
      createdAt: "2026-02-28T00:00:01.000Z",
      threadId: "thread-2",
      requestId: "request-1",
      payload: {
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow edits in workspace only",
              },
              {
                label: "danger-full-access",
                description: "Allow unrestricted access",
              },
            ],
          },
        ],
      },
    });

    expect(parsed.type).toBe("user-input.requested");
    if (parsed.type !== "user-input.requested") {
      throw new Error("expected user-input.requested");
    }
    expect(parsed.payload.questions[0]?.id).toBe("sandbox_mode");
    expect(parsed.payload.questions[0]?.options).toHaveLength(2);
  });

  it("decodes user-input.resolved with answer map", () => {
    const parsed = decodeRuntimeEvent({
      type: "user-input.resolved",
      eventId: "event-3",
      provider: "claudeAgent",
      sessionId: "runtime-session-2",
      createdAt: "2026-02-28T00:00:02.000Z",
      threadId: "thread-2",
      requestId: "request-1",
      payload: {
        answers: {
          sandbox_mode: "workspace-write",
        },
      },
    });

    expect(parsed.type).toBe("user-input.resolved");
    if (parsed.type !== "user-input.resolved") {
      throw new Error("expected user-input.resolved");
    }
    expect(parsed.payload.answers.sandbox_mode).toBe("workspace-write");
  });

  it("rejects legacy message.delta type", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "message.delta",
        eventId: "event-4",
        provider: "codex",
        sessionId: "runtime-session-3",
        createdAt: "2026-02-28T00:00:03.000Z",
        payload: { delta: "legacy" },
      }),
    ).toThrow();
  });

  it("rejects empty branded canonical ids", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "runtime.error",
        eventId: "event-5",
        provider: "codex",
        sessionId: "runtime-session-3",
        createdAt: "2026-02-28T00:00:03.000Z",
        threadId: "   ",
        payload: { message: "boom" },
      }),
    ).toThrow();
  });

  it("decodes normalized thread token usage snapshots", () => {
    const parsed = decodeRuntimeEvent({
      type: "thread.token-usage.updated",
      eventId: "event-token-usage-1",
      provider: "claudeAgent",
      createdAt: "2026-02-28T00:00:04.000Z",
      threadId: "thread-1",
      payload: {
        usage: {
          usedTokens: 31251,
          maxTokens: 200000,
          toolUses: 25,
          durationMs: 43567,
        },
      },
    });

    expect(parsed.type).toBe("thread.token-usage.updated");
    if (parsed.type !== "thread.token-usage.updated") {
      throw new Error("expected thread.token-usage.updated");
    }
    expect(parsed.payload.usage.maxTokens).toBe(200000);
    expect(parsed.payload.usage.usedTokens).toBe(31251);
  });
});

describe("classifyTaskAgentKind", () => {
  it("classifies agent-flavored, watch-loop, and inert types", () => {
    expect(classifyTaskAgentKind({ taskType: "local_agent" })).toBe("agent");
    expect(classifyTaskAgentKind({ taskType: "local_workflow" })).toBe("agent");
    expect(classifyTaskAgentKind({ taskType: undefined })).toBe("agent");
    expect(classifyTaskAgentKind({ taskType: "brand_new_agent_type" })).toBe("agent");
    expect(classifyTaskAgentKind({ taskType: "local_bash" })).toBe("background");
    expect(classifyTaskAgentKind({ taskType: "monitor" })).toBe("background");
    expect(classifyTaskAgentKind({ taskType: "plan" })).toBe("background");
  });

  it("agent-owned tasks are background unless themselves agent-flavored", () => {
    expect(classifyTaskAgentKind({ taskType: "local_bash", agentId: "owner" })).toBe("background");
    expect(classifyTaskAgentKind({ taskType: undefined, agentId: "owner" })).toBe("background");
    // Nested agent: outlives its parent, stays in the roster.
    expect(classifyTaskAgentKind({ taskType: "local_agent", agentId: "owner" })).toBe("agent");
  });
});

describe("AgentRunIdentity contract", () => {
  const decodeIdentity = Schema.decodeUnknownSync(AgentRunIdentity);
  const decodeRecord = Schema.decodeUnknownSync(AgentRunRecord);

  it("decodes a record with a server-minted agentRunId and a real provider execution id", () => {
    const value = decodeIdentity({
      agentRunId: AgentRunId.make("agent-1"),
      providerExecutionId: ProviderExecutionId.make("ses_real_123"),
      provider: "opencode",
      model: "minimax/minimax-m3",
      role: "main",
    });
    expect(value.providerExecutionId).toBe("ses_real_123");
    expect(value.role).toBe("main");
    expect(value.parentRunId).toBeUndefined();
  });

  it("keeps providerExecutionId optional and absent when the provider gave no id", () => {
    const value = decodeIdentity({
      agentRunId: AgentRunId.make("agent-2"),
      provider: "opencode",
      model: "zhipu/glm-5.3-flash",
      role: "worker",
    });
    expect(value.providerExecutionId).toBeUndefined();
    expect("providerExecutionId" in value).toBe(false);
  });

  it("refuses placeholder strings as provider execution ids", () => {
    expect(isPlaceholderProviderExecutionId("ses_real_123")).toBe(false);
    expect(isPlaceholderProviderExecutionId("")).toBe(true);
    expect(isPlaceholderProviderExecutionId("placeholder")).toBe(true);
    expect(isPlaceholderProviderExecutionId("unknown")).toBe(true);
    expect(isPlaceholderProviderExecutionId("synthetic")).toBe(true);
    expect(isPlaceholderProviderExecutionId("<id>")).toBe(true);
    expect(isPlaceholderProviderExecutionId("<execution_id>")).toBe(true);
    expect(isPlaceholderProviderExecutionId("<run_id>")).toBe(true);
    expect(isPlaceholderProviderExecutionId("<model>")).toBe(true);
    expect(isPlaceholderProviderExecutionId("null")).toBe(true);
    expect(isPlaceholderProviderExecutionId(undefined)).toBe(false);
    expect(isPlaceholderProviderExecutionId(42)).toBe(false);
  });

  it("providerExecutionIdFrom returns null for placeholders and accepts real ids", () => {
    expect(providerExecutionIdFrom("ses_real_123")).toBe("ses_real_123");
    expect(providerExecutionIdFrom("<id>")).toBeNull();
    expect(providerExecutionIdFrom("placeholder")).toBeNull();
    expect(providerExecutionIdFrom(undefined)).toBeNull();
    expect(providerExecutionIdFrom(42)).toBeNull();
  });

  it("distinguishes worker and reviewer roles structurally", () => {
    const worker = decodeIdentity({
      agentRunId: AgentRunId.make("agent-worker"),
      provider: "opencode",
      model: "zhipu/glm-5.3-flash",
      role: "worker",
    });
    const reviewer = decodeIdentity({
      agentRunId: AgentRunId.make("agent-reviewer"),
      provider: "opencode",
      model: "deepseek/deepseek-v4-pro-cheap",
      role: "reviewer",
    });
    expect(worker.role).toBe("worker");
    expect(reviewer.role).toBe("reviewer");
    expect(worker.agentRunId).not.toBe(reviewer.agentRunId);
  });

  it("tracks parent linkage through parentRunId", () => {
    const value = decodeIdentity({
      agentRunId: AgentRunId.make("agent-child"),
      parentRunId: AgentRunId.make("agent-parent"),
      provider: "opencode",
      role: "subagent",
    });
    expect(value.parentRunId).toBe("agent-parent");
  });

  it("covers every terminal status in AgentRunStatus", () => {
    expect(AgentRunStatus.literals).toEqual(["started", "completed", "failed", "cancelled"]);
  });

  it("covers every role in AgentRunRole", () => {
    expect(AgentRunRole.literals).toEqual(["main", "worker", "reviewer", "subagent", "unknown"]);
  });

  it("decodes an AgentRunRecord with terminal status and endedAt", () => {
    const value = decodeRecord({
      agentRunId: AgentRunId.make("agent-3"),
      providerExecutionId: ProviderExecutionId.make("ses_real_3"),
      provider: "opencode",
      model: "minimax/minimax-m3",
      role: "main",
      status: "completed",
      createdAt: "2026-09-11T00:00:00.000Z",
      endedAt: "2026-09-11T00:01:00.000Z",
    });
    expect(value.status).toBe("completed");
    expect(value.endedAt).toBe("2026-09-11T00:01:00.000Z");
  });

  it("preserves the agentRunId across a started → completed transition", () => {
    const started = decodeRecord({
      agentRunId: AgentRunId.make("agent-4"),
      provider: "opencode",
      role: "worker",
      status: "started",
      createdAt: "2026-09-11T00:00:00.000Z",
    });
    const completed = decodeRecord({
      ...started,
      status: "completed",
      endedAt: "2026-09-11T00:01:00.000Z",
    });
    expect(completed.agentRunId).toBe(started.agentRunId);
    expect(completed.status).toBe("completed");
  });
});
