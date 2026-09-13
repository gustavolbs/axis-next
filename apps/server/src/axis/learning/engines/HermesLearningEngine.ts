// @effect-diagnostics nodeBuiltinImport:off - H02 owns private subprocess directories on Node.
import {
  type AxisLearningEngineCancellation,
  AxisLearningEngineCancelledError,
  AxisLearningEngineDeadlineExceededError,
  AxisLearningEngineExecutionError,
  type AxisLearningEngineRequest,
  type AxisLearningEngineStatus,
} from "../../../../../../packages/contracts/src/axisLearningEngine.ts";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { AxisLearningEngine } from "../AxisLearningEngine.ts";
import type { AxisLearningEngineExecutor } from "../AxisLearningEngine.ts";
import * as AxisLearningEngineRuntime from "../AxisLearningEngine.ts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ProcessRunner from "../../../processRunner.ts";
import * as ServerConfig from "../../../config.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import type {
  AxisHermesProvider,
  ServerSettings as ServerSettingsType,
} from "../../../../../../packages/contracts/src/settings.ts";

export const HERMES_AGENT_VERSION = "0.21.1";
export const HERMES_AGENT_RELEASE = "v2026.9.7";
export const HERMES_AGENT_COMMIT = "2237be355906fbe6065ce1815711eee52b2d646e";
export const HERMES_AGENT_REPOSITORY = "https://github.com/NousResearch/hermes-agent";
export const HERMES_AGENT_DECISION_DIGEST =
  "sha256:6dbe4c8afa5b805e3c2938cfe185495766b698067451077cf1209ece2668a1d3";
export const HERMES_AGENT_SOURCE_DIGESTS = {
  runAgent: "51e28e8905ebe1c9442e0c67a7eca0d53e6315414cf8c6927501b130d7650872",
  agentInit: "c70a887f700a98276e76b60f987399af3fc3a994ef860c6788f14550fb2b9a52",
  interruptControl: "bd4cfb0579a14330276985a31b794e6c81226f2fcb726045fa76c19f1154bacc",
} as const;

export interface HermesLearningEngineConfig {
  readonly pythonExecutable: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKeyEnv?: string | undefined;
  /** Resolved in memory from a provider secret; never persisted or sent over RPC. */
  readonly apiKey?: string | undefined;
  /** Fresh, environment-owned HERMES_HOME; global Hermes state is not allowed. */
  readonly hermesHome: string;
  readonly timeoutMs?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
}

const HERMES_PRESET_DEFAULTS: Readonly<
  Record<
    AxisHermesProvider,
    {
      readonly baseUrl: string;
      readonly model: string;
      readonly apiKeyEnv: string;
    }
  >
> = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.4-mini",
    apiKeyEnv: "OPENAI_API_KEY",
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-5.4-mini",
    apiKeyEnv: "OPENROUTER_API_KEY",
  },
  ollama: {
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "llama3.2",
    apiKeyEnv: "OLLAMA_API_KEY",
  },
  custom: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.4-mini",
    apiKeyEnv: "OPENAI_API_KEY",
  },
};

const executableFromPath = (name: string): string | undefined => {
  if (!name.trim()) return undefined;
  if (NodePath.isAbsolute(name)) return name;
  for (const directory of (process.env.PATH ?? "").split(NodePath.delimiter)) {
    if (!directory) continue;
    const candidate = NodePath.join(directory, name);
    try {
      NodeFS.accessSync(candidate, NodeFS.constants.X_OK);
      return candidate;
    } catch {
      // Continue through PATH; a missing interpreter is reported as offline.
    }
  }
  return undefined;
};

const findProviderApiKey = (settings: ServerSettingsType, name: string): string | undefined => {
  for (const instance of Object.values(settings.providerInstances)) {
    const variable = instance.environment?.find((candidate) => candidate.name === name);
    if (variable?.value.trim()) return variable.value;
  }
  return undefined;
};

/** Resolve the friendly settings into the private subprocess configuration. */
export const resolveHermesConfiguration = (input: {
  readonly settings: ServerSettingsType;
  readonly serverConfig: ServerConfig.ServerConfig["Service"];
}): HermesLearningEngineConfig => {
  const configured = input.settings.axisHermes;
  const preset = HERMES_PRESET_DEFAULTS[configured.provider];
  const apiKeyEnv = process.env.AXIS_HERMES_API_KEY_ENV ?? configured.apiKeyEnv ?? preset.apiKeyEnv;
  const pythonExecutable =
    executableFromPath(process.env.AXIS_HERMES_PYTHON || configured.pythonExecutable) ??
    executableFromPath("python3") ??
    executableFromPath("python") ??
    "";
  const hermesHome =
    process.env.AXIS_HERMES_HOME ||
    configured.hermesHome ||
    NodePath.join(input.serverConfig.stateDir, "hermes");
  const apiKey =
    process.env[apiKeyEnv] ??
    findProviderApiKey(input.settings, apiKeyEnv) ??
    (configured.provider === "ollama" ? "ollama" : undefined);
  return {
    pythonExecutable,
    hermesHome,
    model: process.env.AXIS_HERMES_MODEL || configured.model || preset.model,
    baseUrl: process.env.AXIS_HERMES_BASE_URL || configured.baseUrl || preset.baseUrl,
    apiKeyEnv,
    apiKey,
  };
};

/**
 * Fixed source-level bridge for NousResearch/hermes-agent v0.21.1.
 * Request data is read from stdin; it is never interpolated into executable code.
 */
const HERMES_BRIDGE_SOURCE = String.raw`import json
import importlib
import math
import os
import hashlib
import re
import sys
import signal
import stat
import threading
from pathlib import Path
from importlib.metadata import PackageNotFoundError, distribution as package_distribution
from urllib.parse import urlparse

def fail(message):
    print(message, file=sys.stderr)
    raise SystemExit(2)

try:
    expected_version = "${HERMES_AGENT_VERSION}"
    expected_release = "${HERMES_AGENT_RELEASE}"
    expected_commit = "${HERMES_AGENT_COMMIT}"
    expected_repository = "${HERMES_AGENT_REPOSITORY}"
    expected_decision_digest = "${HERMES_AGENT_DECISION_DIGEST}"
    expected_source_digests = {
        "run_agent.py": "${HERMES_AGENT_SOURCE_DIGESTS.runAgent}",
        "agent/agent_init.py": "${HERMES_AGENT_SOURCE_DIGESTS.agentInit}",
        "agent/interrupt_control.py": "${HERMES_AGENT_SOURCE_DIGESTS.interruptControl}",
    }

    try:
        request = json.load(sys.stdin)
    except Exception:
        fail("Hermes learning engine received invalid configuration.")
    if not isinstance(request, dict):
        fail("Hermes learning engine received invalid configuration.")
    if (
        request.get("agentVersion") != expected_version
        or request.get("agentRelease") != expected_release
        or request.get("agentCommit") != expected_commit
        or request.get("decisionDigest") != expected_decision_digest
    ):
        fail("Hermes learning engine decision is not approved for this runtime.")

    api_key_env = request.get("apiKeyEnv", "OPENAI_API_KEY")
    base_url = request.get("baseUrl")
    model = request.get("model")
    prompt = request.get("prompt")
    timeout_ms = request.get("timeoutMs")
    if (
        not isinstance(api_key_env, str)
        or re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", api_key_env) is None
        or not isinstance(base_url, str)
        or not base_url.strip()
        or urlparse(base_url).scheme not in ("http", "https")
        or not urlparse(base_url).netloc
        or not isinstance(model, str)
        or not model.strip()
        or not isinstance(prompt, str)
        or not prompt.strip()
        or isinstance(timeout_ms, bool)
        or not isinstance(timeout_ms, (int, float))
        or not math.isfinite(timeout_ms)
        or timeout_ms <= 0
        or timeout_ms > 120000
    ):
        fail("Hermes learning engine received invalid configuration.")

    hermes_home = os.environ.get("HERMES_HOME")
    run_root = os.environ.get("AXIS_HERMES_RUN_ROOT")
    cwd = os.getcwd()

    def is_private_directory(path):
        try:
            directory_stat = os.stat(path, follow_symlinks=False)
        except OSError:
            return False
        owner_matches = not hasattr(os, "getuid") or directory_stat.st_uid == os.getuid()
        return (
            stat.S_ISDIR(directory_stat.st_mode)
            and not os.path.islink(path)
            and stat.S_IMODE(directory_stat.st_mode) & 0o077 == 0
            and owner_matches
        )

    if (
        not run_root
        or not os.path.isabs(run_root)
        or not is_private_directory(run_root)
        or not hermes_home
        or not os.path.isabs(hermes_home)
        or not is_private_directory(hermes_home)
        or not os.path.isabs(cwd)
        or not is_private_directory(cwd)
        or os.path.realpath(hermes_home) == os.path.realpath(cwd)
        or os.path.dirname(os.path.realpath(hermes_home)) != os.path.realpath(run_root)
        or os.path.dirname(os.path.realpath(cwd)) != os.path.realpath(run_root)
    ):
        fail("Hermes learning engine runtime directories are not private.")

    try:
        hermes_distribution = package_distribution("hermes-agent")
        installed_version = hermes_distribution.version
        direct_url_text = hermes_distribution.read_text("direct_url.json")
    except PackageNotFoundError:
        fail("Hermes learning engine requires the hermes-agent package.")
    except Exception:
        fail("Hermes learning engine could not verify its pinned installation.")
    if installed_version != expected_version:
        fail(f"Hermes learning engine requires hermes-agent=={expected_version}.")

    try:
        direct_url = json.loads(direct_url_text or "")
        vcs_info = direct_url.get("vcs_info")
        repository = direct_url.get("url")
        if isinstance(repository, str) and repository.startswith("git+"):
            repository = repository[4:]
        if isinstance(repository, str) and repository.endswith(".git"):
            repository = repository[:-4]
        if isinstance(repository, str):
            repository = repository.rstrip("/")
    except Exception:
        fail("Hermes learning engine could not verify its pinned installation.")
    if (
        not isinstance(direct_url, dict)
        or not isinstance(vcs_info, dict)
        or repository != expected_repository
        or vcs_info.get("vcs") != "git"
        or vcs_info.get("commit_id") != expected_commit
        or vcs_info.get("requested_revision") not in (expected_release, expected_commit)
    ):
        fail("Hermes learning engine installation does not match the pinned release.")

    def source_path_for(module_name):
        try:
            source_spec = importlib.util.find_spec(module_name)
        except Exception:
            fail("Hermes learning engine could not locate its pinned runtime source.")
        source_path = None if source_spec is None else source_spec.origin
        if not source_path or Path(source_path).suffix != ".py":
            fail("Hermes learning engine could not verify its pinned runtime source.")
        return Path(source_path)

    def verify_source(source_path, source_name):
        try:
            source_digest = hashlib.sha256(source_path.read_bytes()).hexdigest()
        except OSError:
            fail("Hermes learning engine could not verify its pinned runtime source.")
        if source_digest != expected_source_digests[source_name]:
            fail("Hermes learning engine runtime source does not match the pinned release.")

    verify_source(source_path_for("run_agent"), "run_agent.py")
    verify_source(source_path_for("agent.agent_init"), "agent/agent_init.py")
    verify_source(source_path_for("agent.interrupt_control"), "agent/interrupt_control.py")

    run_agent = importlib.import_module("run_agent")
    agent_init = importlib.import_module("agent.agent_init")
    interrupt_control = importlib.import_module("agent.interrupt_control")

    AIAgent = getattr(run_agent, "AIAgent", None)
    if AIAgent is None:
        fail("Hermes learning engine could not load its pinned runtime.")
    api_key = os.environ.get(api_key_env)
    if not api_key:
        fail("Hermes learning engine is missing its configured API key.")

    agent = AIAgent(
        provider="custom",
        base_url=base_url,
        api_key=api_key,
        model=model,
        enabled_toolsets=[],
        skip_context_files=True,
        skip_memory=True,
        skip_background_review=True,
        max_iterations=2,
        max_tokens=1500,
        run_budget_seconds=timeout_ms / 1000,
        quiet_mode=True,
        reasoning_config={"enabled": True, "effort": "high"},
    )
    try:
        if agent.valid_tool_names:
            fail("Hermes learning engine unexpectedly enabled tools.")
        interrupted = threading.Event()
        interrupt_started = threading.Event()
        interrupt_done = threading.Event()
        interrupt_error = []
        conversation_done = threading.Event()
        result_holder = {}
        worker = None
        run_timeout_seconds = timeout_ms / 1000.0
        interrupt_timeout_seconds = 2.0
        worker_join_timeout_seconds = 2.0
        cleanup_timeout_seconds = 2.0

        # AIAgent binds its execution thread in run_conversation(). Keep that call on a worker so the
        # main thread remains the signal/control thread; interrupt() is called and awaited there.
        def run_conversation():
            try:
                result_holder["result"] = agent.run_conversation(prompt)
            except BaseException as error:
                result_holder["error"] = error
            finally:
                conversation_done.set()

        def request_interrupt():
            if interrupt_started.is_set():
                return
            interrupt_started.set()
            interrupted.set()

            def interrupt_agent():
                try:
                    agent.interrupt(hard_cancel=True)
                except BaseException as error:
                    interrupt_error.append(error)
                finally:
                    interrupt_done.set()

            threading.Thread(
                target=interrupt_agent,
                name="axis-hermes-interrupt",
                daemon=True,
            ).start()

        def interrupt(_signum, _frame):
            request_interrupt()

        signals_installed = False
        cleanup_error = []
        previous_sigterm = signal.signal(signal.SIGTERM, interrupt)
        previous_sigint = signal.signal(signal.SIGINT, interrupt)
        signals_installed = True
        signal.siginterrupt(signal.SIGTERM, True)
        signal.siginterrupt(signal.SIGINT, True)
        worker = threading.Thread(
            target=run_conversation,
            name="axis-hermes-conversation",
            daemon=True,
        )
        try:
            worker.start()
            conversation_finished = conversation_done.wait(timeout=run_timeout_seconds)
            if not conversation_finished and not interrupted.is_set():
                request_interrupt()

            if interrupted.is_set():
                if not interrupt_done.wait(timeout=interrupt_timeout_seconds):
                    fail("Hermes learning engine interrupt did not finish within its deadline.")
                if interrupt_error:
                    fail("Hermes learning engine hard cancellation failed.")
                worker.join(timeout=worker_join_timeout_seconds)
                if worker.is_alive():
                    fail("Hermes learning engine worker did not terminate before its deadline.")
                fail("Hermes learning engine run was interrupted.")
            if not conversation_finished:
                fail("Hermes learning engine worker did not finish within its deadline.")
        finally:
            if signals_installed:
                signal.signal(signal.SIGTERM, previous_sigterm)
                signal.signal(signal.SIGINT, previous_sigint)

        worker.join(timeout=worker_join_timeout_seconds)
        if worker.is_alive():
            fail("Hermes learning engine worker did not finish within its deadline.")
        if "error" in result_holder:
            raise result_holder["error"]
        result = result_holder.get("result")
        if not isinstance(result, dict):
            fail("Hermes learning engine returned an invalid lifecycle result.")
        if result.get("failed") or result.get("interrupted") or not result.get("completed"):
            fail("Hermes learning engine did not complete successfully.")
        response = result.get("final_response")
        if not isinstance(response, str) or not response.strip():
            fail("Hermes learning engine returned an empty response.")
        sys.stdout.write(response)
    finally:
        def close_agent():
            try:
                agent.close()
            except BaseException as error:
                cleanup_error.append(error)

        cleanup_worker = threading.Thread(
            target=close_agent,
            name="axis-hermes-cleanup",
            daemon=True,
        )
        cleanup_worker.start()
        cleanup_worker.join(timeout=cleanup_timeout_seconds)
        if cleanup_worker.is_alive():
            fail("Hermes learning engine cleanup did not finish within its deadline.")
        if cleanup_error:
            fail("Hermes learning engine cleanup failed.")
except SystemExit:
    raise
except Exception:
    fail("Hermes learning engine execution failed.")
`;

const defaultApiKeyEnv = "OPENAI_API_KEY";
const defaultTimeoutMs = 45_000;
const defaultMaxOutputBytes = 64 * 1024;
const maxDeadlineMs = 120_000;
const privateRunPrefix = "axis-hermes-run-";
const forceKillAfterMs = 2_000;
const forceKillAfter = Duration.millis(forceKillAfterMs);
const privateDirectoryMode = 0o700;
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const executionError = (message: string) => new AxisLearningEngineExecutionError({ message });

const cancelledBySignal = (signal: AbortSignal) =>
  Effect.callback<never, AxisLearningEngineCancelledError>((resume) => {
    const finish = () =>
      resume(
        Effect.fail(
          new AxisLearningEngineCancelledError({
            message: "The Hermes learning engine run was cancelled.",
          }),
        ),
      );
    if (signal.aborted) {
      finish();
      return;
    }
    signal.addEventListener("abort", finish, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", finish));
  });

type HermesPrivateRunDirectories = {
  readonly root: string;
  readonly cwd: string;
  readonly hermesHome: string;
};

const assertPrivateDirectory = (directory: string): void => {
  const stats = NodeFS.lstatSync(directory);
  const currentUid = process.getuid?.();
  if (
    !stats.isDirectory() ||
    (stats.mode & 0o077) !== 0 ||
    (currentUid !== undefined && stats.uid !== currentUid)
  ) {
    throw new Error("Hermes runtime directory is not private.");
  }
};

const ensurePrivateDirectoryRoot = (directory: string): void => {
  if (NodeFS.existsSync(directory)) {
    if (NodeFS.lstatSync(directory).isSymbolicLink()) {
      throw new Error("Hermes runtime directory root must not be a symlink.");
    }
    assertPrivateDirectory(directory);
    return;
  }
  NodeFS.mkdirSync(directory, { recursive: true, mode: privateDirectoryMode });
  assertPrivateDirectory(directory);
};

const configError = (config: HermesLearningEngineConfig): string | undefined => {
  if (!config.pythonExecutable.trim() || !NodePath.isAbsolute(config.pythonExecutable)) {
    return "Hermes learning engine is selected but AXIS_HERMES_PYTHON is missing or not absolute.";
  }
  if (!config.model.trim())
    return "Hermes learning engine is selected but AXIS_HERMES_MODEL is missing.";
  if (!config.baseUrl.trim())
    return "Hermes learning engine is selected but AXIS_HERMES_BASE_URL is missing.";
  try {
    const url = new URL(config.baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "Hermes learning engine requires an HTTP(S) base URL.";
    }
  } catch {
    return "Hermes learning engine is selected but AXIS_HERMES_BASE_URL is invalid.";
  }
  if (!config.hermesHome.trim() || !NodePath.isAbsolute(config.hermesHome)) {
    return "Hermes learning engine is selected but AXIS_HERMES_HOME is missing or not absolute.";
  }
  const apiKeyEnv = config.apiKeyEnv ?? defaultApiKeyEnv;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
    return "Hermes learning engine requires a valid API key environment name.";
  }
  if (apiKeyEnv === "HERMES_HOME" || apiKeyEnv === "AXIS_HERMES_RUN_ROOT") {
    return "Hermes learning engine reserves its runtime directory environment names.";
  }
  if (
    config.timeoutMs !== undefined &&
    (!Number.isSafeInteger(config.timeoutMs) ||
      config.timeoutMs <= 0 ||
      config.timeoutMs > maxDeadlineMs)
  ) {
    return "Hermes learning engine timeout is outside the supported bound.";
  }
  if (
    config.maxOutputBytes !== undefined &&
    (!Number.isSafeInteger(config.maxOutputBytes) || config.maxOutputBytes <= 0)
  ) {
    return "Hermes learning engine output limit is invalid.";
  }
  return undefined;
};

const statusForHermesConfiguration = (
  config: HermesLearningEngineConfig,
  enabled: boolean,
): AxisLearningEngineStatus => {
  if (!enabled) {
    return {
      availability: "absent",
      engineId: `hermes-agent@${HERMES_AGENT_VERSION}`,
      message: "Hermes is disabled.",
    };
  }
  const invalid = configError(config);
  if (invalid !== undefined) {
    return {
      availability: "offline",
      engineId: `hermes-agent@${HERMES_AGENT_VERSION}`,
      message: invalid,
    };
  }
  if (!config.apiKey) {
    return {
      availability: "offline",
      engineId: `hermes-agent@${HERMES_AGENT_VERSION}`,
      message: `Hermes needs the ${config.apiKeyEnv ?? "configured"} credential. Configure it in Providers or choose Ollama.`,
    };
  }
  return {
    availability: "available",
    engineId: `hermes-agent@${HERMES_AGENT_VERSION}`,
    message: `NousResearch/hermes-agent ${HERMES_AGENT_RELEASE}`,
  };
};

const allocatePrivateRunDirectories = (
  hermesHomeRoot: string,
): Effect.Effect<HermesPrivateRunDirectories, AxisLearningEngineExecutionError> =>
  Effect.try({
    try: () => {
      ensurePrivateDirectoryRoot(hermesHomeRoot);
      const root = NodeFS.mkdtempSync(NodePath.join(hermesHomeRoot, privateRunPrefix));
      try {
        const hermesHome = NodeFS.mkdtempSync(NodePath.join(root, "home-"));
        const cwd = NodeFS.mkdtempSync(NodePath.join(root, "cwd-"));
        NodeFS.chmodSync(root, privateDirectoryMode);
        NodeFS.chmodSync(hermesHome, privateDirectoryMode);
        NodeFS.chmodSync(cwd, privateDirectoryMode);
        assertPrivateDirectory(root);
        assertPrivateDirectory(hermesHome);
        assertPrivateDirectory(cwd);
        return { root, cwd, hermesHome };
      } catch (error) {
        NodeFS.rmSync(root, { recursive: true, force: true });
        throw error;
      }
    },
    catch: () =>
      executionError("Hermes learning engine could not create private runtime directories."),
  });

const releasePrivateRunDirectories = (directories: HermesPrivateRunDirectories) =>
  Effect.sync(() => {
    NodeFS.rmSync(directories.root, { recursive: true, force: true });
  });

const buildPrompt = (request: AxisLearningEngineRequest): string =>
  [
    "Analyze the bounded Axis learning observations below and return JSON only.",
    "Return either the exact AxisLearningEngineOutput shape with typed proposals or a no-change result.",
    "Do not claim that a rule was applied, a proposal was persisted, or a test was executed.",
    `Requested context and scope: ${JSON.stringify({ contextId: request.contextId, scope: request.scope })}`,
    `Evidence references: ${JSON.stringify(request.evidenceRefs)}`,
    `Observations:\n${request.content}`,
  ].join("\n\n");

const makeRunInput = (
  config: HermesLearningEngineConfig,
  request: AxisLearningEngineRequest,
  directories: HermesPrivateRunDirectories,
) => ({
  ...(() => {
    const timeoutMs = Math.min(request.deadlineMs, config.timeoutMs ?? defaultTimeoutMs);
    return {
      timeout: Duration.millis(timeoutMs),
      stdin: JSON.stringify({
        apiKeyEnv: config.apiKeyEnv ?? defaultApiKeyEnv,
        baseUrl: config.baseUrl,
        model: config.model,
        prompt: buildPrompt(request),
        agentVersion: HERMES_AGENT_VERSION,
        agentRelease: HERMES_AGENT_RELEASE,
        agentCommit: HERMES_AGENT_COMMIT,
        decisionDigest: HERMES_AGENT_DECISION_DIGEST,
        timeoutMs,
      }),
    };
  })(),
  command: config.pythonExecutable,
  args: ["-c", HERMES_BRIDGE_SOURCE],
  cwd: directories.cwd,
  forceKillAfter,
  maxOutputBytes: config.maxOutputBytes ?? defaultMaxOutputBytes,
  outputMode: "error" as const,
  env: {
    HERMES_HOME: directories.hermesHome,
    AXIS_HERMES_RUN_ROOT: directories.root,
    ...((config.apiKey ?? process.env[config.apiKeyEnv ?? defaultApiKeyEnv]) === undefined
      ? {}
      : {
          [config.apiKeyEnv ?? defaultApiKeyEnv]:
            config.apiKey ?? process.env[config.apiKeyEnv ?? defaultApiKeyEnv],
        }),
  },
  extendEnv: false,
});

const parseOutput = (stdout: string): Effect.Effect<unknown, AxisLearningEngineExecutionError> =>
  Effect.try({
    try: () => decodeJson(stdout),
    catch: () => executionError("Hermes learning engine returned non-JSON output."),
  });

export const make = (
  config: HermesLearningEngineConfig,
): Effect.Effect<AxisLearningEngineExecutor, never, ProcessRunner.ProcessRunner> =>
  Effect.gen(function* () {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const invalidConfig = configError(config);
    if (invalidConfig !== undefined) {
      return {
        status: {
          availability: "offline",
          engineId: `hermes-agent@${HERMES_AGENT_VERSION}`,
          message: invalidConfig,
        },
        run: () => Effect.fail(executionError(invalidConfig)),
      } satisfies AxisLearningEngineExecutor;
    }
    const run = (
      request: AxisLearningEngineRequest,
      cancellation: AxisLearningEngineCancellation,
    ) => {
      const process = Effect.acquireUseRelease(
        allocatePrivateRunDirectories(config.hermesHome),
        (directories) => processRunner.run(makeRunInput(config, request, directories)),
        releasePrivateRunDirectories,
      ) as Effect.Effect<
        ProcessRunner.ProcessRunOutput,
        AxisLearningEngineExecutionError | ProcessRunner.ProcessRunError,
        never
      >;
      const execution = process.pipe(
        Effect.flatMap(
          (
            result,
          ): Effect.Effect<
            unknown,
            AxisLearningEngineExecutionError | AxisLearningEngineDeadlineExceededError
          > => {
            if (result.timedOut) {
              return Effect.fail(
                new AxisLearningEngineDeadlineExceededError({ deadlineMs: request.deadlineMs }),
              );
            }
            if (result.code !== 0) {
              return Effect.fail(executionError("Hermes learning engine process failed."));
            }
            if (
              result.stdoutInvalidUtf8 ||
              result.stdoutTruncated ||
              result.stdout.trim().length === 0
            ) {
              return Effect.fail(executionError("Hermes learning engine returned invalid output."));
            }
            return parseOutput(result.stdout);
          },
        ),
        Effect.mapError((error) => {
          if (error._tag === "AxisLearningEngineDeadlineExceededError") return error;
          if (error._tag === "AxisLearningEngineExecutionError") return error;
          if (error._tag === "ProcessTimeoutError") {
            return new AxisLearningEngineDeadlineExceededError({ deadlineMs: request.deadlineMs });
          }
          return executionError("Hermes learning engine process failed.");
        }),
      );
      const bounded =
        cancellation.signal === undefined
          ? execution
          : execution.pipe(Effect.raceFirst(cancelledBySignal(cancellation.signal)));
      return bounded as unknown as Effect.Effect<
        unknown,
        | AxisLearningEngineCancelledError
        | AxisLearningEngineExecutionError
        | AxisLearningEngineDeadlineExceededError
      >;
    };

    return {
      status: {
        availability: "available",
        engineId: `hermes-agent@${HERMES_AGENT_VERSION}`,
        message: `NousResearch/hermes-agent ${HERMES_AGENT_RELEASE}`,
      },
      run: run as AxisLearningEngineExecutor["run"],
    } satisfies AxisLearningEngineExecutor;
  });

export const layer = (config: HermesLearningEngineConfig) =>
  Layer.effect(
    AxisLearningEngine,
    make(config).pipe(Effect.flatMap(AxisLearningEngineRuntime.make)),
  ).pipe(Layer.provide(ProcessRunner.layer));

/**
 * Live engine used by the server. Settings are resolved again for every run,
 * and the status follows settings changes, so a preset change takes effect
 * without restarting the server.
 */
export const dynamicLayer = Layer.unwrap(
  Effect.gen(function* () {
    const settingsService = yield* ServerSettings.ServerSettingsService;
    const serverConfig = yield* ServerConfig.ServerConfig;
    const processRunner = yield* ProcessRunner.ProcessRunner;
    let currentSettings = yield* settingsService.getSettings.pipe(Effect.orDie);
    let currentConfig = resolveHermesConfiguration({ settings: currentSettings, serverConfig });
    let currentStatus = statusForHermesConfiguration(
      currentConfig,
      currentSettings.axisHermes.enabled || process.env.AXIS_LEARNING_ENGINE === "hermes",
    );

    const update = (next: ServerSettingsType) => {
      currentSettings = next;
      currentConfig = resolveHermesConfiguration({ settings: next, serverConfig });
      currentStatus = statusForHermesConfiguration(
        currentConfig,
        next.axisHermes.enabled || process.env.AXIS_LEARNING_ENGINE === "hermes",
      );
    };
    yield* settingsService.streamChanges.pipe(
      Stream.runForEach((next) => Effect.sync(() => update(next))),
      Effect.forkScoped,
    );

    const executor: AxisLearningEngineExecutor = {
      get status() {
        return currentStatus;
      },
      run: (request, cancellation) =>
        Effect.gen(function* () {
          // Reading here closes the small window between a settings write and
          // the stream notification reaching this service.
          update(
            yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => currentSettings)),
          );
          const configuredExecutor = yield* make(currentConfig).pipe(
            Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
          );
          return yield* configuredExecutor.run(request, cancellation);
        }),
    };
    const engine = yield* AxisLearningEngineRuntime.make(executor);
    return Layer.succeed(AxisLearningEngine, engine);
  }),
).pipe(Layer.provide(ProcessRunner.layer));

export const bridgeSourceForTest = HERMES_BRIDGE_SOURCE;
