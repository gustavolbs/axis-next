import {
  DesktopServerExposureStateSchema,
  type DesktopServerExposureState,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as DesktopBackendManager from "../../backend/DesktopBackendManager.ts";
import * as DesktopServerExposure from "../../backend/DesktopServerExposure.ts";
import { setServerExposureMode } from "./serverExposure.ts";

const decodeState = Schema.decodeUnknownEffect(DesktopServerExposureStateSchema);

function makeExposureLayer(input: {
  readonly state: DesktopServerExposureState;
  readonly requiresBackendRestart: boolean;
}) {
  return Layer.succeed(
    DesktopServerExposure.DesktopServerExposure,
    DesktopServerExposure.DesktopServerExposure.of({
      getState: Effect.succeed(input.state),
      backendConfig: Effect.die("unexpected backendConfig access"),
      configureFromSettings: () => Effect.die("unexpected configureFromSettings"),
      setMode: () =>
        Effect.succeed({
          state: input.state,
          requiresBackendRestart: input.requiresBackendRestart,
        } satisfies DesktopServerExposure.DesktopServerExposureChange),
      setTailscaleServeEnabled: () => Effect.die("unexpected tailscale call"),
      getAdvertisedEndpoints: Effect.succeed([]),
    }),
  );
}

function makePoolLayer(input: {
  readonly restartCalls: Array<{
    readonly id: DesktopBackendPool.BackendInstanceId;
    readonly stopTimeout: Duration.Duration | undefined;
    readonly readyTimeout: Duration.Duration | undefined;
  }>;
  readonly restartError?: DesktopBackendManager.BackendRestartTimeoutError;
}) {
  return Layer.succeed(
    DesktopBackendPool.DesktopBackendPool,
    DesktopBackendPool.DesktopBackendPool.of({
      get: () => Effect.succeed(Option.none()),
      list: Effect.succeed([]),
      primary: Effect.die("unexpected primary access"),
      register: () => Effect.die("unexpected pool.register"),
      unregister: () => Effect.die("unexpected pool.unregister"),
      restart: (id, options) =>
        Effect.sync(() => {
          input.restartCalls.push({
            id,
            stopTimeout: options?.stopTimeout,
            readyTimeout: options?.readyTimeout,
          });
        }).pipe(
          Effect.flatMap(() =>
            input.restartError ? Effect.fail(input.restartError) : Effect.void,
          ),
        ),
    }),
  );
}

const invokeSetMode = (mode: "local-only" | "network-accessible") =>
  setServerExposureMode.handler(mode).pipe(Effect.flatMap(decodeState));

describe("serverExposure IPC", () => {
  it.effect("does not restart the backend when the mode does not change", () =>
    Effect.gen(function* () {
      const restartCalls: Array<{
        readonly id: DesktopBackendPool.BackendInstanceId;
        readonly stopTimeout: Duration.Duration | undefined;
        readonly readyTimeout: Duration.Duration | undefined;
      }> = [];
      const unchangedState: DesktopServerExposureState = {
        mode: "local-only",
        endpointUrl: null,
        advertisedHost: null,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      };
      const layer = Layer.mergeAll(
        makeExposureLayer({ state: unchangedState, requiresBackendRestart: false }),
        makePoolLayer({ restartCalls }),
      );

      const state = yield* invokeSetMode("local-only").pipe(Effect.provide(layer));

      assert.deepEqual(state, unchangedState);
      assert.deepEqual(restartCalls, []);
    }),
  );

  it.effect("hot-restarts the primary backend when flipping to network-accessible", () =>
    Effect.gen(function* () {
      const restartCalls: Array<{
        readonly id: DesktopBackendPool.BackendInstanceId;
        readonly stopTimeout: Duration.Duration | undefined;
        readonly readyTimeout: Duration.Duration | undefined;
      }> = [];
      const networkState: DesktopServerExposureState = {
        mode: "network-accessible",
        endpointUrl: "http://192.168.1.20:4173",
        advertisedHost: "192.168.1.20",
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      };
      const layer = Layer.mergeAll(
        makeExposureLayer({ state: networkState, requiresBackendRestart: true }),
        makePoolLayer({ restartCalls }),
      );

      const state = yield* invokeSetMode("network-accessible").pipe(Effect.provide(layer));

      assert.deepEqual(state, networkState);
      assert.lengthOf(restartCalls, 1);
      assert.equal(restartCalls[0]!.id, DesktopBackendPool.PRIMARY_INSTANCE_ID);
      assert.equal(Duration.toMillis(restartCalls[0]!.stopTimeout!), 5_000);
      assert.equal(Duration.toMillis(restartCalls[0]!.readyTimeout!), 15_000);
    }),
  );

  it.effect("propagates BackendRestartTimeoutError when the hot-restart times out", () =>
    Effect.gen(function* () {
      const restartError = new DesktopBackendManager.BackendRestartTimeoutError({
        instanceId: DesktopBackendPool.PRIMARY_INSTANCE_ID,
        readyTimeoutMs: 15_000,
      });
      const layer = Layer.mergeAll(
        makeExposureLayer({
          state: {
            mode: "network-accessible",
            endpointUrl: "http://192.168.1.20:4173",
            advertisedHost: "192.168.1.20",
            tailscaleServeEnabled: false,
            tailscaleServePort: 443,
          },
          requiresBackendRestart: true,
        }),
        makePoolLayer({ restartCalls: [], restartError }),
      );

      const error = yield* invokeSetMode("network-accessible").pipe(
        Effect.flip,
        Effect.provide(layer),
      );

      assert.ok(Schema.is(DesktopBackendManager.BackendRestartTimeoutError)(error));
      assert.equal(error.instanceId, DesktopBackendPool.PRIMARY_INSTANCE_ID);
      assert.equal(error.readyTimeoutMs, 15_000);
    }),
  );
});
