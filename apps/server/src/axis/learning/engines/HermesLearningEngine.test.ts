// @effect-diagnostics nodeBuiltinImport:off - H02 exercises the owned subprocess against a local HTTP fixture.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  AxisLearningEngineDeadlineExceededError,
  AxisLearningEngineExecutionError,
  AxisLearningEngineRequest,
} from "../../../../../../packages/contracts/src/axisLearningEngine.ts";
import * as AxisLearningEngineRuntime from "../AxisLearningEngine.ts";
import * as ProcessRunner from "../../../processRunner.ts";
import {
  HERMES_AGENT_COMMIT,
  HERMES_AGENT_DECISION_DIGEST,
  HERMES_AGENT_RELEASE,
  HERMES_AGENT_REPOSITORY,
  HERMES_AGENT_SOURCE_DIGESTS,
  HERMES_AGENT_VERSION,
  bridgeSourceForTest,
  make,
} from "./HermesLearningEngine.ts";

const decodeRequest = Schema.decodeUnknownSync(AxisLearningEngineRequest);
const request = decodeRequest({
  contextId: "company_a",
  evidenceRefs: [{ id: "evidence_1", contextId: "company_a" }],
  content: "A focused verification step is repeatedly missing from completed work.",
  deadlineMs: 1_000,
});
const nativeRequest = decodeRequest({
  contextId: request.contextId,
  evidenceRefs: request.evidenceRefs,
  content: request.content,
  deadlineMs: 5_000,
});

const output = (overrides: Partial<ProcessRunner.ProcessRunOutput> = {}) => ({
  stdout: '{"status":"no-change","reason":"No repeated improvement was found."}',
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
  ...overrides,
});

const config = {
  pythonExecutable: "/opt/hermes-python/bin/python",
  model: "gpt-5.6-luna",
  baseUrl: "https://gateway.example/v1",
  hermesHome: "/tmp/axis-hermes-test-home",
};

const hermesTestPython = process.env.AXIS_HERMES_TEST_PYTHON;
const canRunNativeHermes =
  hermesTestPython !== undefined &&
  hermesTestPython.length > 0 &&
  NodeFS.existsSync(hermesTestPython);
const syntheticApiKeyEnv = "AXIS_HERMES_SYNTHETIC_KEY";
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeInvocationConfig = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      agentVersion: Schema.String,
      agentRelease: Schema.String,
      agentCommit: Schema.String,
      decisionDigest: Schema.String,
    }),
  ),
);

type FixtureMode = "success" | "hold";
type LocalHermesFixture = {
  readonly baseUrl: string;
  readonly requestSeen: Deferred.Deferred<void>;
  readonly connectionClosed: Deferred.Deferred<void>;
  readonly close: () => Promise<void>;
};

class LocalHermesFixtureError extends Data.TaggedError("LocalHermesFixtureError")<{
  readonly cause: unknown;
}> {}

const makeLocalHermesFixture = (
  mode: FixtureMode,
): Effect.Effect<LocalHermesFixture, LocalHermesFixtureError> =>
  Effect.gen(function* () {
    const requestSeen = Deferred.makeUnsafe<void>();
    const connectionClosed = Deferred.makeUnsafe<void>();
    const responseBody = [
      `data: ${encodeJson({
        id: "synthetic-chat-completion",
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              content: '{"status":"no-change","reason":"Local fixture."}',
            },
            finish_reason: null,
          },
        ],
      })}`,
      "",
      `data: ${encodeJson({
        id: "synthetic-chat-completion",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    const server = NodeHttp.createServer((incoming, response) => {
      incoming.resume();
      incoming.once("end", () => {
        Deferred.doneUnsafe(requestSeen, Effect.void);
        if (mode === "success") {
          response.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Content-Length": Buffer.byteLength(responseBody),
          });
          response.end(responseBody);
        }
      });
      incoming.once("close", () => {
        Deferred.doneUnsafe(connectionClosed, Effect.void);
      });
    });

    yield* Effect.tryPromise({
      try: () =>
        new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => resolve());
        }),
      catch: (cause) => new LocalHermesFixtureError({ cause }),
    });

    const address = server.address();
    if (address === null || typeof address === "string") {
      return yield* new LocalHermesFixtureError({
        cause: "Local fixture did not expose a TCP address.",
      });
    }

    return {
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      requestSeen,
      connectionClosed,
      close: () =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        }),
    };
  });

const nativeConfig = (fixture: LocalHermesFixture, timeoutMs = 5_000) => ({
  pythonExecutable: hermesTestPython as string,
  model: "synthetic-model",
  baseUrl: fixture.baseUrl,
  apiKeyEnv: syntheticApiKeyEnv,
  hermesHome: NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "axis-hermes-test-")),
  timeoutMs,
});

const nativeProcessRunnerLayer = ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer));

const shellQuote = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("`", "\\`")}"`;

const terminateOwnedTestProcess = (pid: number | undefined): void => {
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process was already reaped by the owned ProcessRunner.
  }
};

const withSyntheticApiKey = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => process.env[syntheticApiKeyEnv]),
    () => {
      process.env[syntheticApiKeyEnv] = "synthetic-only";
      return effect;
    },
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[syntheticApiKeyEnv];
        else process.env[syntheticApiKeyEnv] = previous;
      }),
  );

it.effect("invokes the pinned native runtime with bounded stdin and no secret payload", () =>
  Effect.gen(function* () {
    let invocation: ProcessRunner.ProcessRunInput | undefined;
    const invocations: ProcessRunner.ProcessRunInput[] = [];
    const processRunner: ProcessRunner.ProcessRunner["Service"] = {
      run: (input) => {
        expect(input.cwd).toBeDefined();
        expect(input.env?.HERMES_HOME).toBeDefined();
        expect(input.env?.AXIS_HERMES_RUN_ROOT).toBeDefined();
        expect(NodeFS.statSync(input.cwd as string).isDirectory()).toBe(true);
        expect(NodeFS.statSync(input.env?.HERMES_HOME as string).isDirectory()).toBe(true);
        expect(NodeFS.statSync(input.env?.AXIS_HERMES_RUN_ROOT as string).isDirectory()).toBe(true);
        expect(input.cwd).not.toBe(input.env?.HERMES_HOME);
        expect(NodePath.dirname(input.cwd as string)).toBe(input.env?.AXIS_HERMES_RUN_ROOT);
        expect(NodePath.dirname(input.env?.HERMES_HOME as string)).toBe(
          input.env?.AXIS_HERMES_RUN_ROOT,
        );
        expect(NodeFS.statSync(input.cwd as string).mode & 0o077).toBe(0);
        expect(NodeFS.statSync(input.env?.HERMES_HOME as string).mode & 0o077).toBe(0);
        invocation = input;
        invocations.push(input);
        return Effect.succeed(output());
      },
    };
    const executor = yield* make(config).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
    );
    const result = yield* executor.run(request, {});

    expect(result).toEqual({ status: "no-change", reason: "No repeated improvement was found." });
    const firstInvocation = invocation;
    expect(NodeFS.existsSync(firstInvocation?.cwd as string)).toBe(false);
    expect(NodeFS.existsSync(firstInvocation?.env?.HERMES_HOME as string)).toBe(false);
    const secondResult = yield* executor.run(request, {});
    expect(secondResult).toEqual({
      status: "no-change",
      reason: "No repeated improvement was found.",
    });
    expect(invocations).toHaveLength(2);
    expect(invocations[0]?.cwd).not.toBe(invocations[1]?.cwd);
    expect(invocations[0]?.env?.HERMES_HOME).not.toBe(invocations[1]?.env?.HERMES_HOME);
    expect(invocation?.command).toBe(config.pythonExecutable);
    expect(invocation?.args[0]).toBe("-c");
    expect(invocation?.args[1]).toBe(bridgeSourceForTest);
    expect(invocation?.cwd).toBeDefined();
    expect(invocation?.cwd).not.toBe(config.hermesHome);
    expect(invocation?.env?.HERMES_HOME).toBeDefined();
    expect(invocation?.env?.HERMES_HOME).not.toBe(config.hermesHome);
    expect(NodeFS.existsSync(invocation?.cwd as string)).toBe(false);
    expect(NodeFS.existsSync(invocation?.env?.HERMES_HOME as string)).toBe(false);
    expect(invocation?.stdin).toContain(HERMES_AGENT_DECISION_DIGEST);
    const invocationConfig = decodeInvocationConfig(invocation?.stdin);
    expect(invocationConfig).toMatchObject({
      agentVersion: HERMES_AGENT_VERSION,
      agentRelease: HERMES_AGENT_RELEASE,
      agentCommit: HERMES_AGENT_COMMIT,
      decisionDigest: HERMES_AGENT_DECISION_DIGEST,
    });
    expect(invocation?.stdin).not.toContain("OPENAI_API_KEY=");
    expect(invocation?.stdin).not.toContain("secret");
    expect(invocation?.extendEnv).toBe(false);
    expect(invocation?.timeout).toEqual(Duration.millis(request.deadlineMs));
    expect(invocation?.forceKillAfter).toEqual(Duration.seconds(2));
    expect(HERMES_AGENT_VERSION).toBe("0.21.1");
    expect(HERMES_AGENT_RELEASE).toBe("v2026.9.7");
    expect(HERMES_AGENT_COMMIT).toBe("2237be355906fbe6065ce1815711eee52b2d646e");
    expect(HERMES_AGENT_REPOSITORY).toBe("https://github.com/NousResearch/hermes-agent");
    expect(HERMES_AGENT_DECISION_DIGEST).toBe(
      "sha256:6dbe4c8afa5b805e3c2938cfe185495766b698067451077cf1209ece2668a1d3",
    );
    expect(HERMES_AGENT_SOURCE_DIGESTS).toEqual({
      runAgent: "51e28e8905ebe1c9442e0c67a7eca0d53e6315414cf8c6927501b130d7650872",
      agentInit: "c70a887f700a98276e76b60f987399af3fc3a994ef860c6788f14550fb2b9a52",
      interruptControl: "bd4cfb0579a14330276985a31b794e6c81226f2fcb726045fa76c19f1154bacc",
    });
    expect(bridgeSourceForTest).toContain(HERMES_AGENT_SOURCE_DIGESTS.runAgent);
    expect(bridgeSourceForTest).toContain(HERMES_AGENT_SOURCE_DIGESTS.agentInit);
    expect(bridgeSourceForTest).toContain(HERMES_AGENT_SOURCE_DIGESTS.interruptControl);
    expect(bridgeSourceForTest).toContain('package_distribution("hermes-agent")');
    expect(bridgeSourceForTest).toContain('read_text("direct_url.json")');
    expect(bridgeSourceForTest).toContain('vcs_info.get("commit_id") != expected_commit');
    expect(bridgeSourceForTest).toContain('request.get("agentCommit") != expected_commit');
    expect(bridgeSourceForTest).toContain(HERMES_AGENT_REPOSITORY);
    expect(bridgeSourceForTest).toContain("AXIS_HERMES_RUN_ROOT");
    expect(bridgeSourceForTest).toContain("stat.S_IMODE");
    expect(bridgeSourceForTest).toContain("missing its configured API key");
    expect(bridgeSourceForTest).toContain("conversation_done.wait(timeout=run_timeout_seconds)");
    expect(bridgeSourceForTest).toContain("interrupt_done.wait(timeout=interrupt_timeout_seconds)");
    expect(bridgeSourceForTest).toContain("worker.join(timeout=worker_join_timeout_seconds)");
    expect(bridgeSourceForTest).toContain("cleanup_worker.join(timeout=cleanup_timeout_seconds)");
    expect(bridgeSourceForTest.indexOf('request.get("decisionDigest")')).toBeLessThan(
      bridgeSourceForTest.indexOf('importlib.import_module("run_agent")'),
    );
  }),
);

it.effect("validates native output through the Axis learning engine boundary", () =>
  Effect.gen(function* () {
    const processRunner: ProcessRunner.ProcessRunner["Service"] = {
      run: () =>
        Effect.succeed(
          output({
            stdout: '{"status":"proposals","proposals":[]}',
          }),
        ),
    };
    const executor = yield* make(config).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
    );
    const engine = yield* AxisLearningEngineRuntime.make(executor);
    const result = yield* engine.run(request).pipe(Effect.result);

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure._tag).toBe("AxisLearningEngineOutputError");
  }),
);

it.effect("propagates cancellation through the real Axis learning engine boundary", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const processRunner: ProcessRunner.ProcessRunner["Service"] = {
      run: () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never as Effect.Effect<ProcessRunner.ProcessRunOutput>),
        ),
    };
    const executor = yield* make(config).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
    );
    const engine = yield* AxisLearningEngineRuntime.make(executor);
    const controller = new AbortController();
    const fiber = yield* engine.run(request, { signal: controller.signal }).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    controller.abort();
    const result = yield* Fiber.join(fiber).pipe(Effect.result);

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result))
      expect(result.failure._tag).toBe("AxisLearningEngineCancelledError");
  }),
);

it.effect("honors cancellation at the Hermes executor boundary", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const processRunner: ProcessRunner.ProcessRunner["Service"] = {
      run: () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never as Effect.Effect<ProcessRunner.ProcessRunOutput>),
        ),
    };
    const executor = yield* make(config).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
    );
    const controller = new AbortController();
    const fiber = yield* executor
      .run(request, { signal: controller.signal })
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    controller.abort();
    const result = yield* Fiber.join(fiber).pipe(Effect.result);

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result))
      expect(result.failure._tag).toBe("AxisLearningEngineCancelledError");
  }),
);

it.effect("rejects a failed native process before interpreting its response", () =>
  Effect.gen(function* () {
    const processRunner: ProcessRunner.ProcessRunner["Service"] = {
      run: () => Effect.succeed(output({ code: ChildProcessSpawner.ExitCode(2) })),
    };
    const executor = yield* make(config).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
    );
    const result = yield* executor.run(request, {}).pipe(Effect.result);

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(AxisLearningEngineExecutionError);
      expect(result.failure.message).toContain("process failed");
    }
  }),
);

it.effect("does not turn a timed-out process into a candidate", () =>
  Effect.gen(function* () {
    const processRunner: ProcessRunner.ProcessRunner["Service"] = {
      run: () => Effect.succeed(output({ timedOut: true, code: null })),
    };
    const executor = yield* make(config).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
    );
    const result = yield* executor.run(request, {}).pipe(Effect.result);

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(AxisLearningEngineDeadlineExceededError);
      expect(result.failure._tag).toBe("AxisLearningEngineDeadlineExceededError");
      expect(result.failure).toMatchObject({ deadlineMs: request.deadlineMs });
    }
  }),
);

it.live("terminates a stalled owned child within the deadline and force-kill bound", () =>
  Effect.gen(function* () {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "axis-hermes-process-test-"));
    const nodeScript = NodePath.join(root, "stalled-child.cjs");
    const executable = NodePath.join(root, "python");
    const pidFile = NodePath.join(root, "child.pid");
    NodeFS.writeFileSync(
      nodeScript,
      'process.on("SIGTERM", () => {}); process.on("SIGINT", () => {}); require("node:fs").writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);',
      { mode: 0o700 },
    );
    NodeFS.writeFileSync(
      executable,
      `#!/bin/sh\nprintf '%s' "$$" > ${shellQuote(pidFile)}\nexec ${shellQuote(process.execPath)} ${shellQuote(nodeScript)} ${shellQuote(pidFile)}\n`,
      { mode: 0o700 },
    );
    NodeFS.chmodSync(executable, 0o700);
    let childPid: number | undefined;
    const startedAt = yield* Clock.currentTimeMillis;
    try {
      const executor = yield* make({
        ...config,
        pythonExecutable: executable,
        hermesHome: NodePath.join(root, "hermes-home"),
        timeoutMs: 1_500,
      }).pipe(Effect.provide(nativeProcessRunnerLayer));
      const result = yield* executor.run(request, {}).pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("AxisLearningEngineDeadlineExceededError");
      }
      childPid = Number(NodeFS.readFileSync(pidFile, "utf8"));
      expect(Number.isSafeInteger(childPid)).toBe(true);
      expect(() => process.kill(childPid as number, 0)).toThrow();
      expect((yield* Clock.currentTimeMillis) - startedAt).toBeLessThan(7_000);
    } finally {
      terminateOwnedTestProcess(childPid);
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  }),
);

it.live.skipIf(!canRunNativeHermes)(
  "proves H02-E01 through the pinned Hermes runtime and a local synthetic upstream",
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeLocalHermesFixture("success");
      const hermesConfig = nativeConfig(fixture);
      try {
        const executor = yield* make(hermesConfig).pipe(Effect.provide(nativeProcessRunnerLayer));
        const result = yield* executor.run(nativeRequest, {});

        expect(result).toEqual({ status: "no-change", reason: "Local fixture." });
        const requestReceived = yield* Deferred.await(fixture.requestSeen).pipe(
          Effect.timeoutOption(Duration.seconds(5)),
        );
        expect(requestReceived._tag).toBe("Some");
      } finally {
        yield* Effect.promise(() => fixture.close());
        NodeFS.rmSync(hermesConfig.hermesHome, { recursive: true, force: true });
      }
    }).pipe(withSyntheticApiKey),
);

it.live.skipIf(!canRunNativeHermes)(
  "bounds a stalled Hermes child and proves owned process shutdown",
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeLocalHermesFixture("hold");
      const hermesConfig = nativeConfig(fixture, 150);
      const startedAt = yield* Clock.currentTimeMillis;
      try {
        const executor = yield* make(hermesConfig).pipe(Effect.provide(nativeProcessRunnerLayer));
        const result = yield* executor.run(request, {}).pipe(Effect.result);

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(AxisLearningEngineDeadlineExceededError);
          expect(result.failure._tag).toBe("AxisLearningEngineDeadlineExceededError");
          expect(result.failure).toMatchObject({ deadlineMs: request.deadlineMs });
        }
        const requestReceived = yield* Deferred.await(fixture.requestSeen).pipe(
          Effect.timeoutOption(Duration.millis(500)),
        );
        if (Option.isSome(requestReceived)) {
          const connectionWasClosed = yield* Deferred.await(fixture.connectionClosed).pipe(
            Effect.timeoutOption(Duration.seconds(3)),
          );
          expect(Option.isSome(connectionWasClosed)).toBe(true);
        }
        expect((yield* Clock.currentTimeMillis) - startedAt).toBeLessThan(4_000);
      } finally {
        yield* Effect.promise(() => fixture.close());
        NodeFS.rmSync(hermesConfig.hermesHome, { recursive: true, force: true });
      }
    }).pipe(withSyntheticApiKey),
);

it.live.skipIf(!canRunNativeHermes)(
  "cancels a real Hermes child without exposing partial output",
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeLocalHermesFixture("hold");
      const hermesConfig = nativeConfig(fixture);
      const controller = new AbortController();
      try {
        const executor = yield* make(hermesConfig).pipe(Effect.provide(nativeProcessRunnerLayer));
        const engine = yield* AxisLearningEngineRuntime.make(executor);
        const fiber = yield* engine
          .run(request, { signal: controller.signal })
          .pipe(Effect.forkChild);
        const requestReceived = yield* Deferred.await(fixture.requestSeen).pipe(
          Effect.timeoutOption(Duration.seconds(5)),
        );
        expect(requestReceived._tag).toBe("Some");
        controller.abort();
        const result = yield* Fiber.join(fiber).pipe(Effect.result);

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result))
          expect(result.failure._tag).toBe("AxisLearningEngineCancelledError");
        const connectionWasClosed = yield* Deferred.await(fixture.connectionClosed).pipe(
          Effect.timeoutOption(Duration.seconds(3)),
        );
        expect(connectionWasClosed._tag).toBe("Some");
      } finally {
        yield* Effect.promise(() => fixture.close());
        NodeFS.rmSync(hermesConfig.hermesHome, { recursive: true, force: true });
      }
    }).pipe(withSyntheticApiKey),
);
