import { EnvironmentId, WS_METHODS, type TokenEfficiencySnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { executeAtomQuery } from "./runtime.ts";
import { createServerEnvironmentAtoms } from "./server.ts";

const environment = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("token-efficiency-test"),
  label: "Token efficiency test",
  httpBaseUrl: "https://example.test",
  wsBaseUrl: "wss://example.test",
});

describe("server tokenEfficiency query", () => {
  it.effect("uses the RPC and refreshes its typed snapshot", () =>
    Effect.gen(function* () {
      let calls = 0;
      const client = {
        [WS_METHODS.serverGetTokenEfficiency]: (_input: {}) => {
          calls += 1;
          return Effect.succeed({
            contractVersion: 1 as const,
            generatedAt: "2026-09-07T00:00:00.000Z",
            baselines: [],
            aggregates: [],
          } satisfies TokenEfficiencySnapshot);
        },
      } as unknown as WsRpcProtocolClient;
      const supervisor = EnvironmentSupervisor.of({
        target: environment,
        state: yield* SubscriptionRef.make<SupervisorConnectionState>({
          ...AVAILABLE_CONNECTION_STATE,
          phase: "connected",
        }),
        session: yield* SubscriptionRef.make(
          Option.some<RpcSession>({
            client,
            initialConfig: Effect.succeed(null as never),
            subscribeServerConfig: () => Stream.empty,
            ready: Effect.void,
            probe: Effect.void,
            closed: Effect.never,
          }),
        ),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor["Service"]);
      const environments = EnvironmentRegistry.of({
        run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
        followStream: (_id, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor, supervisor),
      } as EnvironmentRegistry["Service"]);
      const cache = EnvironmentCacheStore.of({
        loadShell: () => Effect.succeed(Option.none()),
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeed(Option.none()),
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        loadServerConfig: () => Effect.succeed(Option.none()),
        saveServerConfig: () => Effect.void,
        loadVcsRefs: () => Effect.succeed(Option.none()),
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });
      const runtime = Atom.runtime(
        Layer.merge(
          Layer.succeed(EnvironmentRegistry, environments),
          Layer.succeed(EnvironmentCacheStore, cache),
        ),
      );
      const atoms = createServerEnvironmentAtoms(runtime, {
        initialConfigValueAtom: () => Atom.make(null),
      });
      const atom = atoms.tokenEfficiency({ environmentId: environment.environmentId, input: {} });
      const atomRegistry = AtomRegistry.make();
      const first = yield* Effect.promise(() => executeAtomQuery(atomRegistry, atom));
      const second = yield* Effect.promise(() =>
        executeAtomQuery(atomRegistry, atom, { refresh: true }),
      );

      expect(AsyncResult.isSuccess(first)).toBe(true);
      expect(AsyncResult.isSuccess(second)).toBe(true);
      if (!AsyncResult.isSuccess(first) || !AsyncResult.isSuccess(second)) {
        throw new Error("expected token efficiency query to succeed");
      }
      expect(first.value.contractVersion).toBe(1);
      expect(second.value.generatedAt).toBe("2026-09-07T00:00:00.000Z");
      expect(calls).toBe(2);
      atomRegistry.dispose();
    }),
  );
});
