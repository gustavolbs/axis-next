/**
 * AgentRunRegistry - Server-owned identity for dispatched agents.
 *
 * The router mints an `AgentRunId` for every main T3 turn dispatch at the
 * moment the turn-start command is processed. The record is updated as the provider
 * surfaces a real `providerExecutionId`, a parent linkage, and a terminal
 * status; the registry is the single source of truth for the correlation
 * between server-owned runs and provider-side session ids.
 *
 * Lifetime: records are currently process-local and remain available for the
 * lifetime of this registry. Durable retention and restart recovery are not
 * implemented here. The registry survives compaction and reconnect events;
 * it does not depend on `session.exited` sweeps.
 *
 * Identity rules enforced here:
 * - `agentRunId` is server-minted and unique across the lifetime of the
 *   router. Two agents dispatched in the same millisecond receive
 *   distinct ids derived from a UUID.
 * - `providerExecutionId` is patched in only when the provider surfaces a
 *   real id. Placeholder strings (`<id>`, `placeholder`, `unknown`,
 *   `synthetic`, empty) are rejected by `providerExecutionIdFrom` and
 *   the field stays absent.
 * - `parentRunId` resolves through the registry so a child `session.created`
 *   that arrives after the parent dispatch still binds correctly.
 * - Cancellation, retry and reconnect reuse the existing `agentRunId`.
 * - Worker and reviewer roles are supported by the registry and remain
 *   distinct when a server-owned dispatcher registers them. The current
 *   provider ingestion path only discovers the main T3 turn; internal
 *   OpenCode child sessions still need an explicit dispatch/lifecycle bridge.
 *
 * @module AgentRunRegistry
 */
import {
  AgentRunId,
  AgentRunRecord,
  AgentRunRole,
  AgentRunStatus,
  type ProviderDriverKind,
  ProviderExecutionId,
  providerExecutionIdFrom,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";

const TERMINAL_STATUSES: ReadonlySet<AgentRunStatus> = new Set<AgentRunStatus>([
  "completed",
  "failed",
  "cancelled",
]);

const mintAgentRunId = Effect.gen(function* () {
  const entropy = yield* Random.nextIntBetween(0, Number.MAX_SAFE_INTEGER);
  const wall = yield* Clock.currentTimeMillis;
  return AgentRunId.make(`agent-${wall.toString(16)}-${entropy.toString(16)}`);
});

const toProviderExecutionId = (
  value: ProviderExecutionId | string | null | undefined,
): ProviderExecutionId | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return providerExecutionIdFrom(value);
  return value;
};

export class AgentRunNotFoundError extends Error {
  readonly _tag = "AgentRunNotFoundError" as const;
  constructor(args: { readonly agentRunId: AgentRunId }) {
    super(`No agent run registered for ${args.agentRunId}`);
    this.name = "AgentRunNotFoundError";
  }
}

export interface RegisterAgentRunInput {
  readonly agentRunId?: AgentRunId;
  readonly providerExecutionId?: ProviderExecutionId | string | null;
  readonly parentRunId?: AgentRunId;
  readonly provider: ProviderDriverKind;
  readonly model?: string;
  readonly role: AgentRunRole;
}

export interface PatchAgentRunInput {
  readonly agentRunId: AgentRunId;
  readonly providerExecutionId?: ProviderExecutionId | string | null;
  readonly parentRunId?: AgentRunId;
  readonly status?: AgentRunStatus;
}

export interface AgentRunRegistryShape {
  readonly register: (input: RegisterAgentRunInput) => Effect.Effect<AgentRunRecord>;
  readonly patch: (
    input: PatchAgentRunInput,
  ) => Effect.Effect<AgentRunRecord, AgentRunNotFoundError>;
  readonly get: (agentRunId: AgentRunId) => Effect.Effect<AgentRunRecord | null>;
  readonly findByProviderExecutionId: (
    providerExecutionId: ProviderExecutionId,
  ) => Effect.Effect<AgentRunRecord | null>;
  readonly findOrCreateByProviderExecutionId: (input: {
    readonly providerExecutionId: ProviderExecutionId;
    readonly provider: ProviderDriverKind;
    readonly model?: string;
    readonly role: AgentRunRole;
    readonly parentRunId?: AgentRunId;
  }) => Effect.Effect<AgentRunRecord>;
  readonly list: () => Effect.Effect<ReadonlyArray<AgentRunRecord>>;
}

export class AgentRunRegistryService extends Context.Service<
  AgentRunRegistryService,
  AgentRunRegistryShape
>()("t3/orchestration/Services/AgentRunRegistry/AgentRunRegistryService") {}

interface MutableRegistryState {
  readonly byId: Map<AgentRunId, AgentRunRecord>;
  readonly byProviderExecutionId: Map<ProviderExecutionId, AgentRunId>;
}

const buildRegistryShape = (state: MutableRegistryState): AgentRunRegistryShape => {
  const nowIso = Effect.gen(function* () {
    const now = yield* DateTime.now;
    return DateTime.formatIso(now);
  });

  const register = (input: RegisterAgentRunInput): Effect.Effect<AgentRunRecord> =>
    Effect.gen(function* () {
      const providerExecutionId = toProviderExecutionId(input.providerExecutionId);
      if (providerExecutionId !== null) {
        const existingId = state.byProviderExecutionId.get(providerExecutionId);
        if (existingId !== undefined) {
          const existing = state.byId.get(existingId);
          if (existing !== undefined) {
            // Re-registering the same provider execution id must not
            // mint a new agentRunId: the provider already chose this
            // identity once.
            if (input.parentRunId !== undefined && existing.parentRunId === undefined) {
              const patched: AgentRunRecord = {
                ...existing,
                parentRunId: input.parentRunId,
              };
              state.byId.set(existing.agentRunId, patched);
              return patched;
            }
            return existing;
          }
        }
      }
      const agentRunId = input.agentRunId ?? (yield* mintAgentRunId);
      const createdAt = yield* nowIso;
      const record: AgentRunRecord = {
        agentRunId,
        ...(providerExecutionId !== null ? { providerExecutionId } : {}),
        ...(input.parentRunId !== undefined ? { parentRunId: input.parentRunId } : {}),
        provider: input.provider,
        ...(input.model !== undefined ? { model: input.model } : {}),
        role: input.role,
        status: "started",
        createdAt,
      };
      state.byId.set(agentRunId, record);
      if (providerExecutionId !== null) {
        state.byProviderExecutionId.set(providerExecutionId, agentRunId);
      }
      return record;
    });

  const patch = (input: PatchAgentRunInput): Effect.Effect<AgentRunRecord, AgentRunNotFoundError> =>
    Effect.gen(function* () {
      const existing = state.byId.get(input.agentRunId);
      if (existing === undefined) {
        return yield* Effect.fail(new AgentRunNotFoundError({ agentRunId: input.agentRunId }));
      }
      const providerExecutionId = toProviderExecutionId(input.providerExecutionId);
      let next: AgentRunRecord = existing;
      if (providerExecutionId !== null && existing.providerExecutionId === undefined) {
        next = { ...next, providerExecutionId };
        state.byProviderExecutionId.set(providerExecutionId, existing.agentRunId);
      }
      if (input.parentRunId !== undefined && existing.parentRunId === undefined) {
        next = { ...next, parentRunId: input.parentRunId };
      }
      if (
        input.status !== undefined &&
        input.status !== existing.status &&
        !TERMINAL_STATUSES.has(existing.status)
      ) {
        const endedAt = yield* nowIso;
        next = { ...next, status: input.status, endedAt };
      }
      state.byId.set(existing.agentRunId, next);
      return next;
    });

  const get = (agentRunId: AgentRunId): Effect.Effect<AgentRunRecord | null> =>
    Effect.sync(() => state.byId.get(agentRunId) ?? null);

  const findByProviderExecutionId = (
    providerExecutionId: ProviderExecutionId,
  ): Effect.Effect<AgentRunRecord | null> => {
    const agentRunId = state.byProviderExecutionId.get(providerExecutionId);
    return Effect.sync(() =>
      agentRunId === undefined ? null : (state.byId.get(agentRunId) ?? null),
    );
  };

  const findOrCreateByProviderExecutionId = (input: {
    readonly providerExecutionId: ProviderExecutionId;
    readonly provider: ProviderDriverKind;
    readonly model?: string;
    readonly role: AgentRunRole;
    readonly parentRunId?: AgentRunId;
  }): Effect.Effect<AgentRunRecord> =>
    Effect.gen(function* () {
      const existingId = state.byProviderExecutionId.get(input.providerExecutionId);
      if (existingId !== undefined) {
        const existing = state.byId.get(existingId);
        if (existing !== undefined) return existing;
      }
      return yield* register({
        agentRunId: yield* mintAgentRunId,
        providerExecutionId: input.providerExecutionId,
        ...(input.parentRunId !== undefined ? { parentRunId: input.parentRunId } : {}),
        provider: input.provider,
        ...(input.model !== undefined ? { model: input.model } : {}),
        role: input.role,
      });
    });

  const list = (): Effect.Effect<ReadonlyArray<AgentRunRecord>> =>
    Effect.sync(() => Array.from(state.byId.values()));

  return {
    register,
    patch,
    get,
    findByProviderExecutionId,
    findOrCreateByProviderExecutionId,
    list,
  };
};

export const makeAgentRunRegistryLive = (): AgentRunRegistryShape =>
  buildRegistryShape({
    byId: new Map<AgentRunId, AgentRunRecord>(),
    byProviderExecutionId: new Map<ProviderExecutionId, AgentRunId>(),
  });

export const AgentRunRegistryLive: Layer.Layer<AgentRunRegistryService> = Layer.sync(
  AgentRunRegistryService,
  () => makeAgentRunRegistryLive(),
);

export const makeAgentRunRegistryTest = (
  initial: ReadonlyArray<AgentRunRecord> = [],
): AgentRunRegistryShape => {
  const state: MutableRegistryState = {
    byId: new Map(initial.map((record) => [record.agentRunId, record])),
    byProviderExecutionId: new Map(
      initial
        .filter((record) => record.providerExecutionId !== undefined)
        .map((record) => [record.providerExecutionId as ProviderExecutionId, record.agentRunId]),
    ),
  };
  return buildRegistryShape(state);
};
