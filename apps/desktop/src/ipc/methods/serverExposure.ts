import {
  AdvertisedEndpoint,
  DesktopServerExposureModeSchema,
  DesktopServerExposureStateSchema,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopObservability from "../../app/DesktopObservability.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as DesktopServerExposure from "../../backend/DesktopServerExposure.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const SetTailscaleServeEnabledInput = Schema.Struct({
  enabled: Schema.Boolean,
  port: Schema.optionalKey(Schema.Number),
});

export const getServerExposureState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_SERVER_EXPOSURE_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopServerExposureStateSchema,
  handler: Effect.fn("desktop.ipc.serverExposure.getState")(function* () {
    const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
    return yield* serverExposure.getState;
  }),
});

const { logError: logServerExposureError } = DesktopObservability.makeComponentLogger(
  "desktop-server-exposure-ipc",
);

export const setServerExposureMode = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_SERVER_EXPOSURE_MODE_CHANNEL,
  payload: DesktopServerExposureModeSchema,
  result: DesktopServerExposureStateSchema,
  handler: Effect.fn("desktop.ipc.serverExposure.setMode")(function* (mode) {
    const pool = yield* DesktopBackendPool.DesktopBackendPool;
    const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
    const change = yield* serverExposure.setMode(mode);
    if (!change.requiresBackendRestart) {
      return change.state;
    }
    // Hot-restart the primary instance only. WSL secondary (if
    // registered) keeps its own loopback bind inside the distro, so we
    // don't touch it. The renderer window survives — only the backend
    // child process is bounced.
    yield* pool
      .restart(DesktopBackendPool.PRIMARY_INSTANCE_ID, {
        stopTimeout: Duration.seconds(5),
        readyTimeout: Duration.seconds(15),
      })
      .pipe(
        Effect.tapError((error) =>
          logServerExposureError("desktop backend hot restart failed", {
            mode,
            error: error.message,
          }),
        ),
      );
    return change.state;
  }),
});

export const setTailscaleServeEnabled = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_TAILSCALE_SERVE_ENABLED_CHANNEL,
  payload: SetTailscaleServeEnabledInput,
  result: DesktopServerExposureStateSchema,
  handler: Effect.fn("desktop.ipc.serverExposure.setTailscaleServeEnabled")(function* (input) {
    const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
    const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
    const change = yield* serverExposure.setTailscaleServeEnabled(input);
    if (change.requiresBackendRestart) {
      // Tailscale Serve plumbing is read by the backend on boot. The
      // IPC surface still chooses a full Electron relaunch here (more
      // conservative than the exposure-mode path which hot-restarts
      // only the child backend); future work can plumb a hot-restart
      // for this branch as well.
      yield* lifecycle.relaunch(
        change.state.tailscaleServeEnabled ? "tailscale-serve-enabled" : "tailscale-serve-disabled",
      );
    }
    return change.state;
  }),
});

export const getAdvertisedEndpoints = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_ADVERTISED_ENDPOINTS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(AdvertisedEndpoint),
  handler: Effect.fn("desktop.ipc.serverExposure.getAdvertisedEndpoints")(function* () {
    const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
    return yield* serverExposure.getAdvertisedEndpoints;
  }),
});
