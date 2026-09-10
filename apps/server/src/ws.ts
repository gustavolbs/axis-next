import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL,
  AuthAccessStreamError,
  AuthAccessWriteScope,
  AxisLearningLifecycleEventId,
  AxisLearningPersistenceError,
  AxisLearningRevisionRequiredError,
  type AxisLearningStoreError,
  AxisLearningValidationError,
  AxisProjectProfileValidationError,
  AxisProjectContextPreviewError,
  AxisLearningProposalId,
  AxisTaskValidationError,
  AxisTaskWorkflowServiceError,
  AxisTaskFeedbackError,
  AxisLearningVersionId,
  AxisOnboardingRpcError,
  type AxisContextId,
  type AxisContext,
  type AxisContextProjectScope,
  type AxisProjectContextPreviewInput,
  type AxisTaskFeedbackRequest,
  type AxisLearningScope,
  axisContextProjectScopeKey,
  type AuthAccessStreamEvent,
  type AuthEnvironmentScope,
  AuthSessionId,
  ClientConnectionMethod,
  ClientDeviceType,
  ClientOs,
  ClientSurface,
  ClientWebDeployment,
  CommandId,
  type DiscoveredLocalServerList,
  EventId,
  type EditorId,
  type FileManagerRevealKind,
  type OrchestrationClientOrigin,
  type OrchestrationCommand,
  type GitActionProgressEvent,
  GitCommandError,
  type GitManagerServiceError,
  OrchestrationDispatchCommandError,
  type OrchestrationEvent,
  type OrchestrationShellStreamEvent,
  type OrchestrationShellStreamItem,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetSnapshotError,
  OrchestrationSearchThreadsError,
  OrchestrationGetTurnDiffError,
  ORCHESTRATION_WS_METHODS,
  type ProjectId,
  type ProjectEntriesFailure,
  type ProjectFileFailure,
  type ProjectFileOperation,
  ProjectListEntriesError,
  ProjectReadFileError,
  ProjectSearchContentsError,
  ProjectSearchEntriesError,
  ProjectWriteFileError,
  ProviderCapabilityInventoryError,
  ProviderUploadFeedbackError,
  ProviderSetupError,
  RelayClientInstallFailedError,
  type RelayClientInstallProgressEvent,
  ServerSelfUpdateError,
  SourceControlRepositoryError,
  type ServerSelfUpdateProgressEvent,
  type FilesystemBrowseFailure,
  FilesystemBrowseError,
  AssetWorkspaceContextNotFoundError,
  AssetWorkspaceContextResolutionError,
  RpcClientId,
  EnvironmentAuthorizationError,
  ThreadId,
  type TerminalAttachStreamEvent,
  type TerminalError,
  type TerminalEvent,
  type TerminalMetadataStreamEvent,
  TerminalSessionLookupError,
  type VcsStatusStreamEvent,
  VcsUnsupportedOperationError,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import { HttpRouter, HttpServerRequest, HttpServerRespondable } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import { isAxisChatsProject, isAxisChatCwd, axisChatsVcsStatus } from "./axis/chats/AxisChats.ts";
import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as ServerConfig from "./config.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import * as Keybindings from "./keybindings.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import {
  projectActivityEvent,
  projectThreadDetailSnapshot,
} from "./orchestration/ActivityPayloadProjection.ts";
import { makeThreadLiveEventCoalescer } from "./orchestration/ThreadLiveEventCoalescer.ts";
import { makeLiveStreamBudget, type RetainedLiveItem } from "./orchestration/LiveStreamBudget.ts";
import {
  cleanupFailedUploadedAttachments,
  normalizeDispatchCommand,
} from "./orchestration/Normalizer.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadDeletionReactor } from "./orchestration/Services/ThreadDeletionReactor.ts";
import {
  observeRpcEffect as instrumentRpcEffect,
  observeRpcStream as instrumentRpcStream,
  observeRpcStreamEffect as instrumentRpcStreamEffect,
} from "./observability/RpcInstrumentation.ts";
import * as ProviderRegistry from "./provider/Services/ProviderRegistry.ts";
import * as ProviderService from "./provider/Services/ProviderService.ts";
import * as ProviderMaintenanceRunner from "./provider/providerMaintenanceRunner.ts";
import { ProviderAuthService } from "./provider/Services/ProviderAuthService.ts";
import { ProviderInstanceRegistry } from "./provider/Services/ProviderInstanceRegistry.ts";
import { makeProviderInstallation } from "./provider/providerInstallation.ts";
import * as ServerSelfUpdate from "./cloud/selfUpdate.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as PreviewAutomationBroker from "./mcp/PreviewAutomationBroker.ts";
import * as PreviewManager from "./preview/Manager.ts";
import { issueAssetUrl } from "./assets/AssetAccess.ts";
import { deletePendingAttachment, issueAttachmentUploadUrl } from "./assets/AttachmentUpload.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import { readWorkflowScript } from "./orchestration/workflowScriptQuery.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as ProjectSetupScriptRunner from "./project/ProjectSetupScriptRunner.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as RemoteOpenTargets from "./environment/RemoteOpenTargets.ts";
import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import { requiredScopeForRpcMethod } from "./auth/RpcAuthorization.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as ResourceTelemetry from "./resourceTelemetry/ResourceTelemetry.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as UsageLimitSources from "./usage/UsageLimitSources.ts";
import * as UsageService from "./usage/UsageService.ts";
import * as TokenEfficiencyMetrics from "./tokenEfficiency/TokenEfficiencyMetrics.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import * as SourceControlDiscovery from "./sourceControl/SourceControlDiscovery.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as AzureDevOpsCli from "./sourceControl/AzureDevOpsCli.ts";
import * as BitbucketApi from "./sourceControl/BitbucketApi.ts";
import * as GitHubCli from "./sourceControl/GitHubCli.ts";
import * as GitLabCli from "./sourceControl/GitLabCli.ts";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "./vcs/VcsProjectConfig.ts";
import * as PairingGrantStore from "./auth/PairingGrantStore.ts";
import * as SessionStore from "./auth/SessionStore.ts";
import { AxisContextCatalogStore } from "./axis/contexts/AxisContextCatalogStore.ts";
import { AxisProjectProfileStore } from "./axis/projects/AxisProjectProfileStore.ts";
import { AxisProjectScope } from "./axis/projects/AxisProjectScope.ts";
import { AxisProjectContextPreview } from "./axis/projects/AxisProjectContextPreview.ts";
import { AxisScheduledActivityRunner } from "./axis/scheduled/AxisScheduledActivityRunner.ts";
import { AxisLearningStore } from "./axis/learning/AxisLearningStore.ts";
import { AxisLearningService } from "./axis/learning/AxisLearningService.ts";
import { AxisTaskStore } from "./axis/tasks/AxisTaskStore.ts";
import { AxisTaskWorkflowService } from "./axis/tasks/AxisTaskWorkflowService.ts";
import { AxisTaskFeedbackService } from "./axis/learning/AxisTaskFeedbackService.ts";
import { AxisWorkHubSourceSync } from "./axis/workHub/AxisWorkHubSourceSync.ts";
import { AxisWorkHubCacheStore } from "./axis/workHub/AxisWorkHubCacheStore.ts";
import { AxisScratchChatRunner } from "./axis/scratch/AxisScratchChatRunner.ts";
import { AxisOnboardingService } from "./axis/onboarding/AxisOnboardingService.ts";
import { failEnvironmentAuthInvalid, failEnvironmentInternal } from "./auth/http.ts";
import * as RelayClient from "@t3tools/shared/relayClient";
const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const CONFIG_DISCOVERY_TIMEOUT = Duration.seconds(5);

/** Environment administrators can select a catalog context; other sessions retain their context. */
export const resolveAxisCallerContextId = (
  session: { readonly subject: string; readonly scopes: ReadonlyArray<AuthEnvironmentScope> },
  contexts: ReadonlyArray<Pick<AxisContext, "id" | "kind">>,
  requestedContextId?: AxisContextId,
): AxisContextId | undefined => {
  if (requestedContextId !== undefined && session.scopes.includes(AuthAccessWriteScope)) {
    return contexts.find((context) => context.id === requestedContextId)?.id;
  }
  return (
    contexts.find((context) => context.id === session.subject)?.id ??
    contexts.find((context) => context.kind === "personal")?.id
  );
};

type AxisTaskScopeIdentity = {
  readonly contextId: string;
  readonly project: {
    readonly environmentId: string;
    readonly projectId: string;
  };
};

export const axisTaskScopeMatchesValidatedScope = (
  requested: AxisTaskScopeIdentity,
  validated: AxisTaskScopeIdentity,
): boolean =>
  requested.contextId === validated.contextId &&
  requested.project.environmentId === validated.project.environmentId &&
  requested.project.projectId === validated.project.projectId;

const resolveDiscoveryForConfig = <A, E, R>(
  discovery: Effect.Effect<A, E, R>,
  onTimeout: () => A,
) =>
  discovery.pipe(
    Effect.timeoutOption(CONFIG_DISCOVERY_TIMEOUT),
    Effect.map(Option.getOrElse(onTimeout)),
  );

export const resolveAvailableEditorsForConfig = <A, E, R>(
  discovery: Effect.Effect<ReadonlyArray<A>, E, R>,
) => resolveDiscoveryForConfig(discovery, () => []);

export const resolveFileManagerRevealKindForConfig = <E, R>(
  discovery: Effect.Effect<FileManagerRevealKind | undefined, E, R>,
) => resolveDiscoveryForConfig(discovery, () => undefined);

function unexpectedCompatibilityError(error: never): never {
  throw new Error(`Unhandled compatibility error: ${String(error)}`);
}

/** Preserve the setup runner's broader pre-refactor message normalization. */
function legacySetupFailureDescription(cause: unknown): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    return cause.message;
  }
  return String(cause);
}

function projectEntriesFailureContext(error: WorkspaceEntries.WorkspaceEntriesError): {
  readonly failure: ProjectEntriesFailure;
  readonly normalizedCwd?: string;
  readonly timeout?: string;
  readonly detail?: string;
} {
  switch (error._tag) {
    case "WorkspaceRootNotExistsError":
      return {
        failure: "workspace_root_not_found",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceRootCreateFailedError":
      return {
        failure: "workspace_root_create_failed",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceRootStatFailedError":
      return {
        failure: "workspace_root_stat_failed",
        normalizedCwd: error.normalizedWorkspaceRoot,
        detail: error.phase,
      };
    case "WorkspaceRootNotDirectoryError":
      return {
        failure: "workspace_root_not_directory",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceSearchIndexCreateFailed":
      return {
        failure: "search_index_create_failed",
        normalizedCwd: error.cwd,
        detail: error.reason,
      };
    case "WorkspaceSearchIndexScanTimedOut":
      return {
        failure: "search_index_scan_timed_out",
        normalizedCwd: error.cwd,
        timeout: error.timeout,
      };
    case "WorkspaceSearchIndexSearchFailed":
      return {
        failure: "search_index_search_failed",
        normalizedCwd: error.cwd,
        detail: error.reason,
      };
    default:
      return unexpectedCompatibilityError(error);
  }
}

function filesystemBrowseFailureContext(error: WorkspaceEntries.WorkspaceEntriesBrowseError): {
  readonly failure: FilesystemBrowseFailure;
  readonly parentPath?: string;
  readonly platform?: string;
} {
  switch (error._tag) {
    case "WorkspaceEntriesWindowsPathUnsupportedError":
      return { failure: "windows_path_unsupported", platform: error.platform };
    case "WorkspaceEntriesCurrentProjectRequiredError":
      return { failure: "current_project_required" };
    case "WorkspaceEntriesReadDirectoryError":
      return { failure: "read_directory_failed", parentPath: error.parentPath };
    default:
      return unexpectedCompatibilityError(error);
  }
}

function projectFileFailureContext(
  error:
    | WorkspaceFileSystem.WorkspaceFileSystemError
    | WorkspacePaths.WorkspacePathOutsideRootError,
): {
  readonly failure: ProjectFileFailure;
  readonly resolvedPath?: string;
  readonly resolvedWorkspaceRoot?: string;
  readonly operation?: ProjectFileOperation;
  readonly operationPath?: string;
} {
  switch (error._tag) {
    case "WorkspacePathOutsideRootError":
      return { failure: "workspace_path_outside_root" };
    case "WorkspaceFileSystemOperationError":
      return {
        failure: "operation_failed",
        resolvedPath: error.resolvedPath,
        operation: error.operation,
        operationPath: error.operationPath,
      };
    case "WorkspaceFilePathEscapeError":
      return {
        failure: "resolved_path_outside_root",
        resolvedPath: error.resolvedPath,
        resolvedWorkspaceRoot: error.resolvedWorkspaceRoot,
      };
    case "WorkspacePathNotFileError":
      return { failure: "path_not_file", resolvedPath: error.resolvedPath };
    case "WorkspaceBinaryFileError":
      return { failure: "binary_file", resolvedPath: error.resolvedPath };
    default:
      return unexpectedCompatibilityError(error);
  }
}

function projectSetupScriptCompatibilityDetail(
  error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError,
): string {
  switch (error._tag) {
    case "ProjectSetupScriptOperationError":
      return legacySetupFailureDescription(error.cause);
    case "ProjectSetupScriptProjectNotFoundError":
      return "Project was not found for setup script execution.";
    default:
      return unexpectedCompatibilityError(error);
  }
}

export function isThreadDetailEvent(event: OrchestrationEvent): event is Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.message-sent"
      | "thread.proposed-plan-upserted"
      | "thread.activity-appended"
      | "thread.turn-diff-completed"
      | "thread.reverted"
      | "thread.session-set";
  }
> {
  return (
    event.type === "thread.message-sent" ||
    event.type === "thread.proposed-plan-upserted" ||
    event.type === "thread.activity-appended" ||
    event.type === "thread.turn-diff-completed" ||
    event.type === "thread.reverted" ||
    event.type === "thread.session-set"
  );
}

const PROVIDER_STATUS_DEBOUNCE_MS = 200;

// When a resuming client's cursor is more than this many events behind the
// current head, skip the per-event catch-up replay and send a fresh shell
// snapshot instead. Replaying each intervening event costs a shell refetch;
// past this gap a single O(active-threads) snapshot is cheaper and bounded.
// Matches the event store's default page size (DEFAULT_READ_FROM_SEQUENCE_LIMIT).
const SHELL_RESUME_MAX_GAP = 1_000;

// Thread replay counts only this thread's rows. Busy or pruned unrelated
// streams must not force a full thread snapshot.
const THREAD_RESUME_MAX_EVENTS = 1_000;
// Row count alone does not bound replay memory: a few events with large tool
// payloads can decode to gigabytes. Before replaying, sum the serialized
// payload bytes of the range in SQL and reset with a snapshot past this budget.
const ORCHESTRATION_REPLAY_PAYLOAD_BUDGET_BYTES = 8 * 1024 * 1024;

function toAuthAccessStreamEvent(
  change: PairingGrantStore.BootstrapCredentialChange | SessionStore.SessionCredentialChange,
  revision: number,
  currentSessionId: AuthSessionId,
): AuthAccessStreamEvent {
  switch (change.type) {
    case "pairingLinkUpserted":
      return {
        version: 1,
        revision,
        type: "pairingLinkUpserted",
        payload: change.pairingLink,
      };
    case "pairingLinkRemoved":
      return {
        version: 1,
        revision,
        type: "pairingLinkRemoved",
        payload: { id: change.id },
      };
    case "clientUpserted":
      return {
        version: 1,
        revision,
        type: "clientUpserted",
        payload: {
          ...change.clientSession,
          current: change.clientSession.sessionId === currentSessionId,
        },
      };
    case "clientRemoved":
      return {
        version: 1,
        revision,
        type: "clientRemoved",
        payload: { sessionId: change.sessionId },
      };
  }
}

const isClientSurface = Schema.is(ClientSurface);
const isClientConnectionMethod = Schema.is(ClientConnectionMethod);
const isClientDeviceType = Schema.is(ClientDeviceType);
const isClientOs = Schema.is(ClientOs);
const isClientWebDeployment = Schema.is(ClientWebDeployment);
const MAX_CLIENT_APP_VERSION_LENGTH = 64;
const MAX_CLIENT_BROWSER_LENGTH = 64;
const MAX_CLIENT_DEVICE_MODEL_LENGTH = 80;

// Optional client identity announced on the /ws upgrade URL next to wsTicket.
// Lenient by design: absent or malformed values degrade to {} so a connection
// never fails over attribution metadata.
function readClientConnectionOrigin(
  request: HttpServerRequest.HttpServerRequest,
): OrchestrationClientOrigin {
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) {
    return {};
  }
  const surface = url.value.searchParams.get("clientSurface");
  const appVersion = url.value.searchParams.get("clientAppVersion")?.trim() ?? "";
  return {
    ...(isClientSurface(surface) ? { surface } : {}),
    ...(appVersion !== "" && appVersion.length <= MAX_CLIENT_APP_VERSION_LENGTH
      ? { appVersion }
      : {}),
  };
}

// Client telemetry stays in this socket's RPC layer. It must not become a
// server-global "current client" because several client types can connect at once.
function readClientAnalyticsProps(request: HttpServerRequest.HttpServerRequest) {
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) {
    return {};
  }

  const surface = url.value.searchParams.get("clientSurface");
  const appVersion = url.value.searchParams.get("clientAppVersion")?.trim() ?? "";
  const deviceType = url.value.searchParams.get("clientDeviceType");
  const os = url.value.searchParams.get("clientOs");
  const webDeployment = url.value.searchParams.get("clientWebDeployment");
  const browser = url.value.searchParams.get("clientBrowser")?.trim() ?? "";
  const connectionMethod = url.value.searchParams.get("connectionMethod");
  const rawOsMajorVersion = url.value.searchParams.get("clientOsMajorVersion") ?? "";
  const osMajorVersion = Number(rawOsMajorVersion);
  const deviceModel = url.value.searchParams.get("clientDeviceModel")?.trim() ?? "";
  const isMobile = surface === "mobile";
  const hasOsMajorVersion =
    isMobile && rawOsMajorVersion !== "" && Number.isInteger(osMajorVersion) && osMajorVersion > 0;
  const hasDeviceModel =
    isMobile && deviceModel !== "" && deviceModel.length <= MAX_CLIENT_DEVICE_MODEL_LENGTH;

  return {
    ...(isClientSurface(surface) ? { surface } : {}),
    ...(appVersion !== "" && appVersion.length <= MAX_CLIENT_APP_VERSION_LENGTH
      ? { appVersion, clientAppVersion: appVersion }
      : {}),
    ...(isClientOs(os)
      ? {
          clientOs: os,
          ...(isMobile && (os === "iOS" || os === "Android") ? { os } : {}),
        }
      : {}),
    ...(isClientDeviceType(deviceType) ? { clientDeviceType: deviceType } : {}),
    ...(surface === "web" && isClientWebDeployment(webDeployment) ? { webDeployment } : {}),
    ...(surface === "web" && browser !== "" && browser.length <= MAX_CLIENT_BROWSER_LENGTH
      ? { clientBrowser: browser }
      : {}),
    ...(hasOsMajorVersion ? { osMajorVersion, clientOsMajorVersion: osMajorVersion } : {}),
    ...(hasDeviceModel ? { deviceModel, clientDeviceModel: deviceModel } : {}),
    ...(isClientConnectionMethod(connectionMethod) ? { connectionMethod } : {}),
  };
}

const makeWsRpcLayer = (
  currentSession: EnvironmentAuth.AuthenticatedSession,
  clientOrigin: OrchestrationClientOrigin,
  clientAnalyticsProps: Readonly<Record<string, unknown>>,
  previewAutomationBroker: PreviewAutomationBroker.PreviewAutomationBroker["Service"],
) =>
  WsRpcGroup.toLayer(
    Effect.gen(function* () {
      const currentSessionId = currentSession.sessionId;
      const crypto = yield* Crypto.Crypto;
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
      const threadDeletionReactor = yield* ThreadDeletionReactor;
      const analytics = yield* AnalyticsService.AnalyticsService;
      // Every command dispatched on this connection carries the connecting
      // client's origin, including server-generated bootstrap sub-commands:
      // the client's request caused them.
      const hasClientOrigin =
        clientOrigin.surface !== undefined || clientOrigin.appVersion !== undefined;
      const dispatchFromClient: OrchestrationEngine.OrchestrationEngineShape["dispatch"] = (
        command,
      ) =>
        orchestrationEngine.dispatch(
          command,
          hasClientOrigin ? { origin: clientOrigin } : undefined,
        );
      const recordClientCommandAnalytics = (command: OrchestrationCommand) => {
        switch (command.type) {
          case "thread.create":
            return analytics.record("client.thread.started", clientAnalyticsProps);
          case "thread.turn.start":
            return command.bootstrap?.createThread
              ? Effect.andThen(
                  analytics.record("client.thread.started", clientAnalyticsProps),
                  analytics.record("client.turn.requested", clientAnalyticsProps),
                )
              : analytics.record("client.turn.requested", clientAnalyticsProps);
          default:
            return Effect.void;
        }
      };
      const checkpointDiffQuery = yield* CheckpointDiffQuery.CheckpointDiffQuery;
      const keybindings = yield* Keybindings.Keybindings;
      const environmentTheme = yield* EnvironmentTheme.EnvironmentThemeService;
      const usageLimitSources = yield* UsageLimitSources.UsageLimitSources;
      const externalLauncher = yield* ExternalLauncher.ExternalLauncher;
      const remoteOpenTargets = yield* RemoteOpenTargets.RemoteOpenTargets;
      const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
      const review = yield* ReviewService.ReviewService;
      const vcsProvisioning = yield* VcsProvisioningService.VcsProvisioningService;
      const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const terminalManager = yield* TerminalManager.TerminalManager;
      const previewManager = yield* PreviewManager.PreviewManager;
      const portDiscovery = yield* PortScanner.PortDiscovery;
      const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
      const providerService = yield* ProviderService.ProviderService;
      const providerMaintenanceRunner = yield* ProviderMaintenanceRunner.ProviderMaintenanceRunner;
      const providerAuth = yield* ProviderAuthService;
      const providerInstances = yield* ProviderInstanceRegistry;
      const providerInstallation = yield* makeProviderInstallation();
      const serverUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
      const config = yield* ServerConfig.ServerConfig;
      const lifecycleEvents = yield* ServerLifecycleEvents.ServerLifecycleEvents;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const serverEnv = yield* ServerEnvironment.ServerEnvironment;
      const axisContextCatalog = yield* AxisContextCatalogStore;
      const axisWorkHubCache = yield* AxisWorkHubCacheStore;
      const axisWorkHubSourceSync = yield* AxisWorkHubSourceSync;
      const axisScheduledActivities = yield* AxisScheduledActivityRunner;
      const axisLearning = yield* AxisLearningStore;
      const axisLearningService = yield* Effect.serviceOption(AxisLearningService);
      const axisTasks = yield* AxisTaskStore;
      const axisWorkflow = yield* Effect.serviceOption(AxisTaskWorkflowService);
      const axisTaskFeedback = yield* Effect.serviceOption(AxisTaskFeedbackService);
      const axisOnboarding = yield* Effect.serviceOption(AxisOnboardingService);
      const axisProjectProfile = yield* Effect.serviceOption(AxisProjectProfileStore);
      const axisProjectScope = yield* Effect.serviceOption(AxisProjectScope);
      const axisProjectContextPreview = yield* Effect.serviceOption(AxisProjectContextPreview);
      const requireProjectProfileStore = (): Effect.Effect<
        AxisProjectProfileStore["Service"],
        AxisProjectProfileValidationError
      > =>
        Option.match(axisProjectProfile, {
          onNone: () =>
            Effect.fail(
              new AxisProjectProfileValidationError({
                message: "AxisProjectProfileStore is not configured.",
              }),
            ),
          onSome: (store) => Effect.succeed(store),
        });
      const requireProjectScope = (): Effect.Effect<
        AxisProjectScope["Service"],
        AxisProjectProfileValidationError
      > =>
        Option.match(axisProjectScope, {
          onNone: () =>
            Effect.fail(
              new AxisProjectProfileValidationError({
                message: "AxisProjectScope is not configured.",
              }),
            ),
          onSome: (resolver) => Effect.succeed(resolver),
        });
      const axisScratchChats = yield* AxisScratchChatRunner;
      const onboardingRpcError = (error: unknown) => {
        const tag =
          typeof error === "object" &&
          error !== null &&
          "_tag" in error &&
          typeof error._tag === "string"
            ? error._tag
            : "";
        const code = tag.includes("Conflict")
          ? "conflict"
          : tag.includes("Source")
            ? "source"
            : tag.includes("Analysis")
              ? "analysis"
              : tag.includes("Apply")
                ? "apply"
                : tag.includes("Cancel")
                  ? "cancelled"
                  : tag.includes("Persistence")
                    ? "persistence"
                    : "validation";
        return new AxisOnboardingRpcError({
          code,
          message:
            typeof error === "object" &&
            error !== null &&
            "message" in error &&
            typeof error.message === "string"
              ? error.message
              : String(error),
        });
      };
      const requireAxisOnboarding = (): Effect.Effect<
        AxisOnboardingService["Service"],
        AxisOnboardingRpcError
      > =>
        Option.isNone(axisOnboarding)
          ? Effect.fail(
              new AxisOnboardingRpcError({
                code: "validation",
                message: "Axis onboarding is not configured.",
              }),
            )
          : Effect.succeed(axisOnboarding.value);
      const serverEnvironmentId = serverEnv.getEnvironmentId;
      const workflowContext = Effect.fn("ws.workflowContext")(function* (
        scope: AxisContextProjectScope,
      ) {
        if (Option.isNone(axisWorkflow)) {
          return yield* new AxisTaskWorkflowServiceError({
            reason: "invalid_input",
            message: "Task workflow execution is unavailable.",
          });
        }
        const environmentId = yield* serverEnvironmentId;
        const catalog = yield* axisContextCatalog.get.pipe(
          Effect.mapError(
            () =>
              new AxisTaskWorkflowServiceError({
                reason: "scope_denied",
                message: "Cannot resolve the authenticated project context.",
              }),
          ),
        );
        const contextId = resolveAxisCallerContextId(
          currentSession,
          catalog.catalog.contexts,
          scope.contextId,
        );
        if (contextId === undefined) {
          return yield* new AxisTaskWorkflowServiceError({
            reason: "scope_denied",
            message: "The authenticated caller has no Axis context.",
          });
        }
        return { caller: { environmentId, contextId }, service: axisWorkflow.value };
      });
      const taskFeedbackContext = Effect.fn("ws.taskFeedbackContext")(function* (
        input: AxisTaskFeedbackRequest,
      ) {
        if (Option.isNone(axisTaskFeedback)) {
          return yield* new AxisTaskFeedbackError({
            reason: "observation_failed",
            message: "Task feedback recording is unavailable.",
          });
        }
        const environmentId = yield* serverEnvironmentId;
        if (input.scope.project.environmentId !== environmentId) {
          return yield* new AxisTaskFeedbackError({
            reason: "scope_denied",
            message: "The selected project does not belong to this environment.",
          });
        }
        const catalog = yield* axisContextCatalog.get.pipe(
          Effect.mapError(
            () =>
              new AxisTaskFeedbackError({
                reason: "scope_denied",
                message: "Cannot resolve the authenticated project context.",
              }),
          ),
        );
        const contextId = resolveAxisCallerContextId(
          currentSession,
          catalog.catalog.contexts,
          input.scope.contextId,
        );
        if (contextId === undefined) {
          return yield* new AxisTaskFeedbackError({
            reason: "scope_denied",
            message: "The authenticated caller has no Axis context.",
          });
        }
        return { caller: { environmentId, contextId }, service: axisTaskFeedback.value };
      });
      const projectContextPreview = Effect.fn("ws.projectContextPreview")(function* (
        input: AxisProjectContextPreviewInput,
      ) {
        if (Option.isNone(axisProjectContextPreview)) {
          return yield* new AxisProjectContextPreviewError({
            message: "Project context preview is unavailable.",
          });
        }
        const environmentId = yield* serverEnvironmentId;
        if (
          input.scope.project.environmentId !== environmentId ||
          input.provider.environmentId !== environmentId
        ) {
          return yield* new AxisProjectContextPreviewError({
            message: "The selected project and provider must belong to this environment.",
          });
        }
        const catalog = yield* axisContextCatalog.get.pipe(
          Effect.mapError(
            () =>
              new AxisProjectContextPreviewError({
                message: "Cannot read the Axis context catalog.",
              }),
          ),
        );
        const contextId = resolveAxisCallerContextId(
          currentSession,
          catalog.catalog.contexts,
          input.scope.contextId,
        );
        if (contextId === undefined) {
          return yield* new AxisProjectContextPreviewError({
            message: "The authenticated caller cannot access this Axis context.",
          });
        }
        const instance = yield* providerService.getInstanceInfo(input.provider.instanceId).pipe(
          Effect.mapError(
            () =>
              new AxisProjectContextPreviewError({
                message: "The selected provider is unavailable.",
              }),
          ),
        );
        return yield* axisProjectContextPreview.value
          .resolve({
            scope: input.scope,
            provider: input.provider,
            ...(input.model === undefined ? {} : { model: input.model }),
            step: input.step,
            paths: input.paths,
            caller: { environmentId, contextId },
            driver: instance.driverKind,
          })
          .pipe(
            Effect.mapError(
              () =>
                new AxisProjectContextPreviewError({
                  message: "The selected project context is unavailable.",
                }),
            ),
          );
      });
      const validateProjectScope = (scope: AxisContextProjectScope, operation: "read" | "write") =>
        requireProjectScope().pipe(
          Effect.flatMap((resolver) =>
            serverEnvironmentId.pipe(
              Effect.flatMap((environmentId) =>
                axisContextCatalog.get.pipe(
                  Effect.mapError(
                    () =>
                      new AxisProjectProfileValidationError({
                        message: "The Axis context catalog could not be read.",
                      }),
                  ),
                  Effect.flatMap((catalog) => {
                    // Context selection needs administrative authority. Project
                    // existence, environment and binding are still resolved below.
                    const callerContextId = resolveAxisCallerContextId(
                      currentSession,
                      catalog.catalog.contexts,
                      scope.contextId,
                    );
                    return callerContextId === undefined
                      ? Effect.fail(
                          new AxisProjectProfileValidationError({
                            message: "The authenticated caller has no Axis context.",
                          }),
                        )
                      : resolver
                          .resolveProject({
                            caller: { environmentId, contextId: callerContextId },
                            operation,
                            scope,
                          })
                          .pipe(
                            Effect.mapError(
                              (error) =>
                                new AxisProjectProfileValidationError({ message: error.message }),
                            ),
                          );
                  }),
                ),
              ),
              Effect.map((resolved) => resolved.scope),
            ),
          ),
        );
      const validateTaskProjectScope = (
        scope: AxisContextProjectScope,
        operation: "read" | "write",
      ) =>
        validateProjectScope(scope, operation).pipe(
          Effect.mapError((error) => new AxisTaskValidationError({ message: error.message })),
        );
      const validateLearningScope = (
        scope: AxisLearningScope | undefined,
        operation: "read" | "write",
      ): Effect.Effect<AxisLearningScope | undefined, AxisLearningValidationError> =>
        scope === undefined
          ? Effect.map(Effect.void, () => undefined)
          : axisContextCatalog.get.pipe(
              Effect.mapError(
                () =>
                  new AxisLearningValidationError({
                    message: "The Axis context catalog could not be read.",
                  }),
              ),
              Effect.flatMap((snapshot) => {
                const callerContextId = resolveAxisCallerContextId(
                  currentSession,
                  snapshot.catalog.contexts,
                  scope.contextId,
                );
                if (callerContextId === undefined) {
                  return Effect.fail(
                    new AxisLearningValidationError({
                      message: "The authenticated caller has no Axis context.",
                    }),
                  );
                }
                if (scope.contextId !== callerContextId) {
                  return Effect.fail(
                    new AxisLearningValidationError({
                      message:
                        "The requested Axis context is not owned by the authenticated caller.",
                    }),
                  );
                }
                return snapshot.catalog.contexts.some((context) => context.id === scope.contextId)
                  ? scope.project === undefined
                    ? Effect.succeed(scope)
                    : validateProjectScope(
                        { contextId: scope.contextId, project: scope.project },
                        operation,
                      ).pipe(
                        Effect.as(scope),
                        Effect.mapError(
                          (error) => new AxisLearningValidationError({ message: error.message }),
                        ),
                      )
                  : Effect.fail(
                      new AxisLearningValidationError({
                        message: "The requested Axis context does not exist.",
                      }),
                    );
              }),
            );
      const validateLearningContext = (
        contextId: AxisContextId,
        scope: AxisLearningScope | undefined,
      ): Effect.Effect<AxisLearningScope | undefined, AxisLearningValidationError> =>
        axisContextCatalog.get.pipe(
          Effect.mapError(
            () =>
              new AxisLearningValidationError({
                message: "The Axis context catalog could not be read.",
              }),
          ),
          Effect.flatMap((snapshot) => {
            const callerContextId = resolveAxisCallerContextId(
              currentSession,
              snapshot.catalog.contexts,
              contextId,
            );
            if (callerContextId === undefined) {
              return Effect.fail(
                new AxisLearningValidationError({
                  message: "The authenticated caller has no Axis context.",
                }),
              );
            }
            if (contextId !== callerContextId) {
              return Effect.fail(
                new AxisLearningValidationError({
                  message: "The requested Axis context is not owned by the authenticated caller.",
                }),
              );
            }
            return scope !== undefined && scope.contextId !== contextId
              ? Effect.fail(
                  new AxisLearningValidationError({
                    message: "The Learning scope context does not match the payload context.",
                  }),
                )
              : Effect.succeed(scope);
          }),
        );
      const learningScopeKey = (scope: AxisLearningScope): string =>
        `${scope.contextId}\u0000${
          scope.project === undefined
            ? "context"
            : axisContextProjectScopeKey({ contextId: scope.contextId, project: scope.project })
        }`;
      const validateLearningPayloadScope = (
        contextId: AxisContextId,
        embeddedScope: AxisLearningScope | undefined,
        requestedScope: AxisLearningScope | undefined,
        operation: "read" | "write",
      ): Effect.Effect<AxisLearningScope | undefined, AxisLearningValidationError> => {
        if (
          embeddedScope !== undefined &&
          requestedScope !== undefined &&
          learningScopeKey(embeddedScope) !== learningScopeKey(requestedScope)
        ) {
          return Effect.fail(
            new AxisLearningValidationError({
              message: "The Learning payload contains conflicting scopes.",
            }),
          );
        }
        const effectiveScope = requestedScope ?? embeddedScope;
        return validateLearningContext(contextId, effectiveScope).pipe(
          Effect.flatMap((validatedScope) => validateLearningScope(validatedScope, operation)),
        );
      };
      const validateRequiredLearningScope = (
        scope: AxisLearningScope,
        operation: "read" | "write",
      ): Effect.Effect<AxisLearningScope, AxisLearningValidationError> =>
        Effect.gen(function* () {
          const validatedScope = yield* validateLearningScope(scope, operation);
          if (validatedScope === undefined) {
            return yield* new AxisLearningValidationError({
              message: "This Learning action requires an Axis scope.",
            });
          }
          return validatedScope;
        });
      const validateLearningEntityScope = (
        id: AxisLearningProposalId,
        scope: AxisLearningScope | undefined,
        operation: "read" | "write",
      ): Effect.Effect<AxisLearningScope | AxisContextId, AxisLearningStoreError> =>
        Effect.gen(function* () {
          const lookup =
            scope === undefined
              ? yield* axisContextCatalog.get.pipe(
                  Effect.mapError(
                    () =>
                      new AxisLearningValidationError({
                        message: "The Axis context catalog could not be read.",
                      }),
                  ),
                  Effect.flatMap((snapshot) => {
                    const callerContextId = resolveAxisCallerContextId(
                      currentSession,
                      snapshot.catalog.contexts,
                    );
                    return callerContextId === undefined
                      ? Effect.fail(
                          new AxisLearningValidationError({
                            message: "The authenticated caller has no Axis context.",
                          }),
                        )
                      : Effect.succeed(callerContextId);
                  }),
                )
              : yield* validateRequiredLearningScope(scope, operation);
          yield* axisLearning.getProposal(id, lookup);
          return lookup;
        });
      const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
      const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
      const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
      const canReplayPersistedRange = Effect.fnUntraced(function* (
        afterSequence: number,
        headSequence: number,
        maxGap: number,
      ) {
        const replayGap = headSequence - afterSequence;
        if (replayGap < 0 || replayGap > maxGap) {
          return false;
        }
        const stats = yield* projectionSnapshotQuery
          .getEventReplayStats({
            fromSequenceExclusive: afterSequence,
            toSequenceInclusive: headSequence,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationGetSnapshotError({
                  message: "Failed to measure orchestration replay range",
                  cause,
                }),
            ),
          );
        if (stats.payloadBytes > ORCHESTRATION_REPLAY_PAYLOAD_BUDGET_BYTES) {
          yield* Effect.logDebug("orchestration replay replaced by snapshot", {
            afterSequence,
            headSequence,
            replayGap,
            eventCount: stats.eventCount,
            payloadBytes: stats.payloadBytes,
            payloadBudgetBytes: ORCHESTRATION_REPLAY_PAYLOAD_BUDGET_BYTES,
          });
          return false;
        }
        return true;
      });
      const projectSetupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
      const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
      const rpcClientIds = yield* Ref.make(new Set<RpcClientId>());
      yield* Effect.addFinalizer(() =>
        Ref.get(rpcClientIds).pipe(
          Effect.flatMap((clientIds) =>
            Effect.forEach(
              clientIds,
              (clientId) => backgroundPolicy.removeRpcClient(currentSessionId, clientId),
              {
                discard: true,
              },
            ),
          ),
          Effect.ignore,
        ),
      );
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sourceControlDiscovery = yield* SourceControlDiscovery.SourceControlDiscovery;
      const automaticGitFetchInterval = serverSettings.getSettings.pipe(
        Effect.map(
          (settings) => resolveServerBackgroundActivitySettings(settings).automaticGitFetchInterval,
        ),
        Effect.catch((cause) =>
          Effect.logWarning("Failed to read automatic Git fetch interval setting", {
            detail: cause.message,
          }).pipe(Effect.as(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL)),
        ),
      );
      const sourceControlRepositories =
        yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const pullRequests = yield* PullRequestService.PullRequestService;
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const sessions = yield* SessionStore.SessionStore;
      const processDiagnostics = yield* ProcessDiagnostics.ProcessDiagnostics;
      const processResourceMonitor = yield* ProcessResourceMonitor.ProcessResourceMonitor;
      const resourceTelemetry = yield* ResourceTelemetry.ResourceTelemetry;
      const usage = yield* UsageService.UsageService;
      const tokenEfficiencyMetrics = yield* TokenEfficiencyMetrics.TokenEfficiencyMetrics;
      const relayClient = yield* RelayClient.RelayClient;
      const authorizationError = (requiredScope: AuthEnvironmentScope) =>
        new EnvironmentAuthorizationError({
          message: `The authenticated token is missing required scope: ${requiredScope}.`,
          requiredScope,
        });
      const authorizeEffect = <A, E, R>(
        requiredScope: AuthEnvironmentScope,
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E | EnvironmentAuthorizationError, R> =>
        currentSession.scopes.includes(requiredScope)
          ? effect
          : Effect.fail(authorizationError(requiredScope));
      const authorizeStream = <A, E, R>(
        requiredScope: AuthEnvironmentScope,
        stream: Stream.Stream<A, E, R>,
      ): Stream.Stream<A, E | EnvironmentAuthorizationError, R> =>
        currentSession.scopes.includes(requiredScope)
          ? stream
          : Stream.fail(authorizationError(requiredScope));
      const observeRpcEffect = <A, E, R>(
        method: string,
        effect: Effect.Effect<A, E, R>,
        traceAttributes?: Readonly<Record<string, unknown>>,
      ) =>
        instrumentRpcEffect(
          method,
          authorizeEffect(requiredScopeForRpcMethod(method), effect),
          traceAttributes,
        );
      const observeRpcStream = <A, E, R>(
        method: string,
        stream: Stream.Stream<A, E, R>,
        traceAttributes?: Readonly<Record<string, unknown>>,
      ) =>
        instrumentRpcStream(
          method,
          authorizeStream(requiredScopeForRpcMethod(method), stream),
          traceAttributes,
        );
      const observeRpcStreamEffect = <A, StreamError, StreamContext, EffectError, EffectContext>(
        method: string,
        effect: Effect.Effect<
          Stream.Stream<A, StreamError, StreamContext>,
          EffectError,
          EffectContext
        >,
        traceAttributes?: Readonly<Record<string, unknown>>,
      ) =>
        instrumentRpcStreamEffect(
          method,
          authorizeEffect(requiredScopeForRpcMethod(method), effect),
          traceAttributes,
        );
      const toDispatchCommandError = (cause: unknown, fallbackMessage: string) =>
        isOrchestrationDispatchCommandError(cause)
          ? cause
          : new OrchestrationDispatchCommandError({
              message: cause instanceof Error ? cause.message : fallbackMessage,
              cause,
            });
      const randomUUID = crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) =>
          toDispatchCommandError(cause, "Failed to generate orchestration command identifier."),
        ),
      );
      const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
      const serverCommandId = (tag: string) =>
        randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
      const learningRandomUUID = crypto.randomUUIDv4.pipe(
        Effect.mapError(
          () => new AxisLearningPersistenceError({ operation: "generate learning identifier" }),
        ),
      );
      const learningReviewInput = (note?: string) =>
        Effect.all({
          eventId: learningRandomUUID.pipe(Effect.map(AxisLearningLifecycleEventId.make)),
          createdAt: nowIso,
        }).pipe(
          Effect.map(({ eventId, createdAt }) => ({
            eventId,
            actor: `session:${currentSessionId}`,
            ...(note !== undefined ? { note } : {}),
            createdAt,
          })),
        );

      const loadAuthAccessSnapshot = () =>
        Effect.all({
          pairingLinks: serverAuth.listPairingLinks(),
          clientSessions: serverAuth.listClientSessions(currentSessionId),
        }).pipe(
          Effect.mapError(
            (error) =>
              new AuthAccessStreamError({
                message: error.message,
              }),
          ),
        );

      const appendSetupScriptActivity = (input: {
        readonly threadId: ThreadId;
        readonly kind: "setup-script.requested" | "setup-script.started" | "setup-script.failed";
        readonly summary: string;
        readonly createdAt: string;
        readonly payload: Record<string, unknown>;
        readonly tone: "info" | "error";
      }) =>
        Effect.all({
          commandId: serverCommandId("setup-script-activity"),
          activityId: serverEventId,
        }).pipe(
          Effect.flatMap(({ commandId, activityId }) =>
            dispatchFromClient({
              type: "thread.activity.append",
              commandId,
              threadId: input.threadId,
              activity: {
                id: activityId,
                tone: input.tone,
                kind: input.kind,
                summary: input.summary,
                payload: input.payload,
                turnId: null,
                createdAt: input.createdAt,
              },
              createdAt: input.createdAt,
            }),
          ),
        );

      const toBootstrapDispatchCommandCauseError = (cause: Cause.Cause<unknown>) => {
        const error = Cause.squash(cause);
        return isOrchestrationDispatchCommandError(error)
          ? error
          : new OrchestrationDispatchCommandError({
              message:
                error instanceof Error ? error.message : "Failed to bootstrap thread turn start.",
              cause,
            });
      };

      const toShellStreamEvent = (
        event: OrchestrationEvent,
      ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, never> => {
        switch (event.type) {
          case "project.created":
          case "project.meta-updated":
            return projectUpsertOrRemove(event.payload.projectId, event.sequence);
          case "project.deleted":
            return Effect.succeed(
              Option.some({
                kind: "project-removed" as const,
                sequence: event.sequence,
                projectId: event.payload.projectId,
              }),
            );
          case "thread.deleted":
          case "thread.archived":
            return Effect.succeed(
              Option.some({
                kind: "thread-removed" as const,
                sequence: event.sequence,
                threadId: event.payload.threadId,
              }),
            );
          case "thread.unarchived":
            return threadUpsertOrRemove(event.payload.threadId, event.sequence);
          default:
            if (event.aggregateKind !== "thread") {
              return Effect.succeed(Option.none());
            }
            return threadUpsertOrRemove(ThreadId.make(event.aggregateId), event.sequence);
        }
      };

      // Coalescing makes each projection read represent every event for that
      // aggregate in the current window. Retry a typed persistence failure once
      // so a brief read failure cannot strand the shell at its previous state.
      // If both attempts fail, log and drop the stream item; treating an error as
      // a missing row would incorrectly remove a still-active aggregate.
      const retryShellProjectionRead = <A, E>(
        aggregateKind: "project" | "thread",
        aggregateId: string,
        read: Effect.Effect<A, E>,
      ): Effect.Effect<Option.Option<A>, never, never> =>
        read.pipe(
          Effect.retry({ times: 1 }),
          Effect.map(Option.some),
          Effect.tapError((error) =>
            Effect.logWarning("orchestration shell projection refetch failed", {
              aggregateKind,
              aggregateId,
              error,
            }),
          ),
          Effect.orElseSucceed(() => Option.none()),
        );

      const projectUpsertOrRemove = (
        projectId: ProjectId,
        sequence: number,
      ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, never> =>
        retryShellProjectionRead(
          "project",
          projectId,
          projectionSnapshotQuery.getProjectShellById(projectId),
        ).pipe(
          Effect.map(
            Option.flatMap((project) =>
              Option.match(project, {
                onNone: () =>
                  Option.some<OrchestrationShellStreamEvent>({
                    kind: "project-removed" as const,
                    sequence,
                    projectId,
                  }),
                onSome: (nextProject) =>
                  Option.some<OrchestrationShellStreamEvent>({
                    kind: "project-upserted" as const,
                    sequence,
                    project: nextProject,
                  }),
              }),
            ),
          ),
        );

      // Refetch a thread's shell and emit an upsert if it is still active, or a
      // `thread-removed` if the projection has no active row for it. Emitting a
      // removal on a `none` (rather than dropping the event) is what keeps
      // coalescing correct: when a burst collapses a `thread.deleted`/`archived`
      // into a later refetchable event for the same thread, the refetch returns
      // `none` for the now-inactive row and this still tells the sidebar to drop
      // it. A `thread-removed` the client does not have is a harmless no-op. The
      // projection commits in the same transaction before the event publishes,
      // so a `none` reliably means the thread is deleted or archived, not
      // not-yet-persisted.
      const threadUpsertOrRemove = (
        threadId: ThreadId,
        sequence: number,
      ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, never> =>
        retryShellProjectionRead(
          "thread",
          threadId,
          projectionSnapshotQuery.getThreadShellById(threadId),
        ).pipe(
          Effect.map(
            Option.flatMap((thread) =>
              Option.match(thread, {
                onNone: () =>
                  Option.some<OrchestrationShellStreamEvent>({
                    kind: "thread-removed" as const,
                    sequence,
                    threadId,
                  }),
                onSome: (nextThread) =>
                  Option.some<OrchestrationShellStreamEvent>({
                    kind: "thread-upserted" as const,
                    sequence,
                    thread: nextThread,
                  }),
              }),
            ),
          ),
        );

      // Turn a batch of domain events into shell stream items, coalescing by
      // aggregate first. `toShellStreamEvent` re-reads the *current* projected
      // shell for an aggregate, so within a batch only the latest event per
      // aggregate matters: a burst of streaming `thread.message-sent` deltas for
      // one thread collapses into a single shell refetch, and an unrelated
      // `thread.created` in the same batch is never stuck behind those DB reads.
      //
      // Input events arrive in ascending sequence; we keep the last (highest
      // sequence) event per aggregate, then re-sort ascending before emitting so
      // the client — which applies shell items strictly by increasing sequence
      // and drops any `sequence <= snapshotSequence` — never skips a coalesced
      // item. The refetch runs with bounded concurrency (order-preserving).
      const SHELL_REFETCH_CONCURRENCY = 8;
      const coalesceShellEvents = (
        events: ReadonlyArray<OrchestrationEvent>,
      ): Effect.Effect<ReadonlyArray<OrchestrationShellStreamEvent>, never, never> =>
        Effect.gen(function* () {
          if (events.length === 0) {
            return [];
          }
          const latestByAggregate = new Map<string, OrchestrationEvent>();
          for (const event of events) {
            latestByAggregate.set(`${event.aggregateKind}:${event.aggregateId}`, event);
          }
          const survivors = Array.from(latestByAggregate.values()).sort(
            (left, right) => left.sequence - right.sequence,
          );
          const shellEvents = yield* Effect.forEach(survivors, toShellStreamEvent, {
            concurrency: SHELL_REFETCH_CONCURRENCY,
          });
          return shellEvents.flatMap((option) => (Option.isSome(option) ? [option.value] : []));
        });

      // Small time/size window over which to coalesce shell events. The window
      // bounds the worst-case added latency for a brand-new thread to appear in
      // the sidebar (imperceptible), while collapsing high-frequency streaming
      // traffic so it can't serialize the shell stream behind per-event DB reads.
      const SHELL_COALESCE_WINDOW = Duration.millis(50);
      const SHELL_COALESCE_MAX_CHUNK = 512;
      const coalesceShellStream = <E, R>(
        stream: Stream.Stream<OrchestrationEvent, E, R>,
      ): Stream.Stream<OrchestrationShellStreamEvent, E, R> =>
        stream.pipe(
          Stream.groupedWithin(SHELL_COALESCE_MAX_CHUNK, SHELL_COALESCE_WINDOW),
          Stream.mapEffect(coalesceShellEvents),
          Stream.flatMap((items) => Stream.fromIterable(items)),
        );

      type ShellLiveInput =
        | { readonly kind: "event"; readonly event: OrchestrationEvent }
        | { readonly kind: "synchronized" };

      // A completion marker is queued alongside raw live events so it cannot
      // overtake an event still waiting in the coalescing window. Split each
      // batch at markers and coalesce only the event segments on either side.
      const coalesceShellLiveInputs = (
        inputs: ReadonlyArray<ShellLiveInput>,
      ): Effect.Effect<ReadonlyArray<OrchestrationShellStreamItem>, never, never> =>
        Effect.gen(function* () {
          const output: Array<OrchestrationShellStreamItem> = [];
          let pendingEvents: Array<OrchestrationEvent> = [];

          for (const input of inputs) {
            if (input.kind === "event") {
              pendingEvents.push(input.event);
              continue;
            }

            output.push(...(yield* coalesceShellEvents(pendingEvents)));
            pendingEvents = [];
            output.push({ kind: "synchronized" });
          }

          output.push(...(yield* coalesceShellEvents(pendingEvents)));
          return output;
        });

      const requireChatWorkspaceWritable = (cwd: string) =>
        isAxisChatCwd(config.stateDir, cwd)
          ? Effect.fail(
              new GitCommandError({
                operation: "workspace.write",
                command: "git",
                cwd,
                detail: "Chats does not support repository changes.",
              }),
            )
          : Effect.void;
      const requireChatTerminalAvailable = (input: {
        readonly threadId: string;
        readonly terminalId?: string | undefined;
      }) =>
        Effect.gen(function* () {
          const thread = yield* projectionSnapshotQuery
            .getThreadShellById(ThreadId.make(input.threadId))
            .pipe(
              Effect.mapError(
                () =>
                  new TerminalSessionLookupError({
                    threadId: input.threadId,
                    terminalId: input.terminalId ?? "default",
                  }),
              ),
            );
          if (Option.isSome(thread) && isAxisChatsProject(thread.value.projectId)) {
            return yield* new TerminalSessionLookupError({
              threadId: input.threadId,
              terminalId: input.terminalId ?? "default",
            });
          }
        });

      const dispatchBootstrapTurnStart = (
        command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
      ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> =>
        Effect.gen(function* () {
          const projectId =
            command.bootstrap?.createThread?.projectId ??
            Option.getOrUndefined(
              yield* projectionSnapshotQuery
                .getThreadShellById(command.threadId)
                .pipe(
                  Effect.mapError((cause) =>
                    toDispatchCommandError(cause, "Failed to resolve chat project"),
                  ),
                ),
            )?.projectId;
          const bootstrap =
            isAxisChatsProject(projectId) || command.bootstrap?.createThread?.projectId === null
              ? command.bootstrap?.createThread
                ? {
                    createThread: {
                      ...command.bootstrap.createThread,
                      branch: null,
                      worktreePath: null,
                    },
                  }
                : undefined
              : command.bootstrap;
          const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command;
          let createdThread = false;
          let targetProjectId = bootstrap?.createThread?.projectId;
          let targetProjectCwd = bootstrap?.prepareWorktree?.projectCwd;
          let targetWorktreePath = bootstrap?.createThread?.worktreePath ?? null;

          const cleanupCreatedThread = () =>
            createdThread
              ? serverCommandId("bootstrap-thread-delete").pipe(
                  Effect.flatMap((commandId) =>
                    dispatchFromClient({
                      type: "thread.delete",
                      commandId,
                      threadId: command.threadId,
                    }),
                  ),
                  Effect.as(true),
                )
              : Effect.succeed(false);

          const recordSetupScriptLaunchFailure = (input: {
            readonly error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError;
            readonly requestedAt: string;
            readonly worktreePath: string;
          }) => {
            const detail = projectSetupScriptCompatibilityDetail(input.error);
            return appendSetupScriptActivity({
              threadId: command.threadId,
              kind: "setup-script.failed",
              summary: "Setup script failed to start",
              createdAt: input.requestedAt,
              payload: {
                detail,
                worktreePath: input.worktreePath,
              },
              tone: "error",
            }).pipe(
              Effect.ignoreCause({ log: false }),
              Effect.flatMap(() =>
                Effect.logWarning("bootstrap turn start failed to launch setup script", {
                  threadId: command.threadId,
                  worktreePath: input.worktreePath,
                  detail,
                }),
              ),
            );
          };

          const recordSetupScriptStarted = (input: {
            readonly requestedAt: string;
            readonly worktreePath: string;
            readonly scriptId: string;
            readonly scriptName: string;
            readonly terminalId: string;
          }) =>
            Effect.gen(function* () {
              const startedAt = yield* nowIso;
              const payload = {
                scriptId: input.scriptId,
                scriptName: input.scriptName,
                terminalId: input.terminalId,
                worktreePath: input.worktreePath,
              };
              yield* Effect.all([
                appendSetupScriptActivity({
                  threadId: command.threadId,
                  kind: "setup-script.requested",
                  summary: "Starting setup script",
                  createdAt: input.requestedAt,
                  payload,
                  tone: "info",
                }),
                appendSetupScriptActivity({
                  threadId: command.threadId,
                  kind: "setup-script.started",
                  summary: "Setup script started",
                  createdAt: startedAt,
                  payload,
                  tone: "info",
                }),
              ]).pipe(
                Effect.asVoid,
                Effect.catch((error) =>
                  Effect.logWarning(
                    "bootstrap turn start launched setup script but failed to record setup activity",
                    {
                      threadId: command.threadId,
                      worktreePath: input.worktreePath,
                      scriptId: input.scriptId,
                      terminalId: input.terminalId,
                      detail: error.message,
                    },
                  ),
                ),
              );
            });

          const runSetupProgram = () =>
            Effect.gen(function* () {
              if (!bootstrap?.runSetupScript || !targetWorktreePath) {
                return;
              }
              const worktreePath = targetWorktreePath;
              const requestedAt = yield* nowIso;
              yield* projectSetupScriptRunner
                .runForThread({
                  threadId: command.threadId,
                  ...(targetProjectId ? { projectId: targetProjectId } : {}),
                  ...(targetProjectCwd ? { projectCwd: targetProjectCwd } : {}),
                  worktreePath,
                })
                .pipe(
                  Effect.matchEffect({
                    onFailure: (error) =>
                      recordSetupScriptLaunchFailure({
                        error,
                        requestedAt,
                        worktreePath,
                      }),
                    onSuccess: (setupResult) => {
                      if (setupResult.status !== "started") {
                        return Effect.void;
                      }
                      return recordSetupScriptStarted({
                        requestedAt,
                        worktreePath,
                        scriptId: setupResult.scriptId,
                        scriptName: setupResult.scriptName,
                        terminalId: setupResult.terminalId,
                      });
                    },
                  }),
                );
            });

          const bootstrapProgram = Effect.gen(function* () {
            if (bootstrap?.createThread) {
              const created = yield* dispatchFromClient({
                type: "thread.create",
                commandId: yield* serverCommandId("bootstrap-thread-create"),
                threadId: command.threadId,
                projectId: bootstrap.createThread.projectId,
                title: bootstrap.createThread.title,
                modelSelection: bootstrap.createThread.modelSelection,
                runtimeMode: bootstrap.createThread.runtimeMode,
                interactionMode: bootstrap.createThread.interactionMode,
                branch: bootstrap.createThread.branch,
                worktreePath: bootstrap.createThread.worktreePath,
                createdAt: bootstrap.createThread.createdAt,
              });
              // The successful create is a fence in the engine command queue:
              // every delete for the prior incarnation committed before it.
              // Drain through that event before setup or turn start can own
              // terminals and provider sessions under the reused thread id.
              yield* threadDeletionReactor.drainThrough(created.sequence);
              createdThread = true;
            }

            if (bootstrap?.prepareWorktree) {
              let worktreeBaseRef = bootstrap.prepareWorktree.baseBranch;
              // "Start from origin" is a stored default; repos without the
              // requested remote branch fall back to the local base branch.
              const startFromOrigin =
                bootstrap.prepareWorktree.startFromOrigin === true &&
                (yield* gitWorkflow.remoteExists({
                  cwd: bootstrap.prepareWorktree.projectCwd,
                  remoteName: "origin",
                }));
              if (startFromOrigin) {
                yield* gitWorkflow.fetchRemote({
                  cwd: bootstrap.prepareWorktree.projectCwd,
                  remoteName: "origin",
                });
                const remoteBaseExists = yield* gitWorkflow.remoteBranchExists({
                  cwd: bootstrap.prepareWorktree.projectCwd,
                  refName: bootstrap.prepareWorktree.baseBranch,
                  remoteName: "origin",
                });
                if (remoteBaseExists) {
                  const resolvedRemoteBase = yield* gitWorkflow.resolveRemoteTrackingCommit({
                    cwd: bootstrap.prepareWorktree.projectCwd,
                    refName: bootstrap.prepareWorktree.baseBranch,
                    fallbackRemoteName: "origin",
                  });
                  worktreeBaseRef = resolvedRemoteBase.commitSha;
                }
              }
              const worktree = yield* gitWorkflow.createWorktree({
                cwd: bootstrap.prepareWorktree.projectCwd,
                refName: worktreeBaseRef,
                newRefName: bootstrap.prepareWorktree.branch,
                baseRefName: bootstrap.prepareWorktree.baseBranch,
                path: null,
              });
              targetWorktreePath = worktree.worktree.path;
              yield* dispatchFromClient({
                type: "thread.meta.update",
                commandId: yield* serverCommandId("bootstrap-thread-meta-update"),
                threadId: command.threadId,
                branch: worktree.worktree.refName,
                worktreePath: targetWorktreePath,
              });
              yield* refreshGitStatus(targetWorktreePath);
            }

            yield* runSetupProgram();

            return yield* dispatchFromClient(finalTurnStartCommand);
          });

          return yield* bootstrapProgram.pipe(
            Effect.catchCause((cause) => {
              const dispatchError = toBootstrapDispatchCommandCauseError(cause);
              if (Cause.hasInterruptsOnly(cause)) {
                return Effect.fail(dispatchError);
              }
              return Effect.uninterruptible(cleanupCreatedThread()).pipe(
                Effect.matchCauseEffect({
                  onFailure: (cleanupCause) =>
                    Effect.logWarning("bootstrap thread cleanup failed", {
                      threadId: command.threadId,
                      detail: Cause.pretty(cleanupCause),
                    }).pipe(Effect.flatMap(() => Effect.fail(dispatchError))),
                  onSuccess: (threadDeleted) =>
                    Effect.fail(
                      threadDeleted
                        ? new OrchestrationDispatchCommandError({
                            message: dispatchError.message,
                            ...(dispatchError.cause !== undefined
                              ? { cause: dispatchError.cause }
                              : {}),
                            bootstrapThreadDisposition: "deleted",
                          })
                        : dispatchError,
                    ),
                }),
              );
            }),
          );
        });

      const dispatchNormalizedCommand = (
        normalizedCommand: OrchestrationCommand,
      ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> => {
        const dispatchEffect =
          normalizedCommand.type === "thread.turn.start" && normalizedCommand.bootstrap
            ? dispatchBootstrapTurnStart(normalizedCommand)
            : dispatchFromClient(normalizedCommand).pipe(
                Effect.tap(({ sequence }) =>
                  // Returning from thread.create is the handoff point at which
                  // clients may start resources for the new incarnation. Use
                  // its event sequence as the exact deletion-cleanup fence.
                  normalizedCommand.type === "thread.create"
                    ? threadDeletionReactor.drainThrough(sequence)
                    : Effect.void,
                ),
                Effect.mapError((cause) =>
                  toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
                ),
              );

        return startup
          .enqueueCommand(dispatchEffect)
          .pipe(
            Effect.mapError((cause) =>
              toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
            ),
          );
      };

      const loadServerConfig = Effect.gen(function* () {
        const keybindingsConfig = yield* keybindings.loadConfigState;
        const providers = yield* providerRegistry.getProviders;
        const settings = ServerSettings.redactServerSettingsForClient(
          yield* serverSettings.getSettings,
        );
        const environment = yield* serverEnvironment.getDescriptor;
        const auth = yield* serverAuth.getDescriptor();
        const availableEditors: ReadonlyArray<EditorId> = yield* resolveAvailableEditorsForConfig(
          externalLauncher.resolveAvailableEditors(),
        );
        const fileManagerRevealKind = availableEditors.includes("file-manager")
          ? yield* resolveFileManagerRevealKindForConfig(
              externalLauncher.resolveFileManagerRevealKind(),
            )
          : undefined;

        return {
          environment,
          auth,
          cwd: config.cwd,
          keybindingsConfigPath: config.keybindingsConfigPath,
          keybindings: keybindingsConfig.keybindings,
          issues: keybindingsConfig.issues,
          providers,
          availableEditors,
          // Same discovery-with-timeout treatment as editors: a slow probe
          // must not stall server.getConfig, so it degrades to no targets.
          remoteOpenTargets: yield* resolveAvailableEditorsForConfig(
            remoteOpenTargets.resolveTargets(),
          ),
          observability: {
            logsDirectoryPath: config.logsDir,
            localTracingEnabled: true,
            ...(config.otlpTracesUrl !== undefined ? { otlpTracesUrl: config.otlpTracesUrl } : {}),
            otlpTracesEnabled: config.otlpTracesUrl !== undefined,
            ...(config.otlpMetricsUrl !== undefined
              ? { otlpMetricsUrl: config.otlpMetricsUrl }
              : {}),
            otlpMetricsEnabled: config.otlpMetricsUrl !== undefined,
          },
          settings,
          shellResumeCompletionMarker: true,
          ...(fileManagerRevealKind === undefined
            ? {}
            : {
                shellRevealInFileManager: true,
                shellRevealInFileManagerKind: fileManagerRevealKind,
              }),
          threadResumeCompletionMarker: true,
          threadSnapshotPagination: true,
        };
      });

      const refreshGitStatus = (cwd: string) =>
        vcsStatusBroadcaster
          .refreshStatus(cwd)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

      return WsRpcGroup.of({
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.dispatchCommand,
            Effect.gen(function* () {
              const normalizedCommand = yield* normalizeDispatchCommand(command);
              // Archive removes the thread from the client, so this transport
              // closes its session and terminals after the command lands.
              // Settlement cleanup is driven by thread.settled events in the
              // provider reactor, including settlements that have no client.
              const archiveCommand =
                normalizedCommand.type === "thread.archive" ? normalizedCommand : undefined;
              // Best-effort on purpose: the user's archive must not
              // fail because this cleanup read blipped, so a failed read
              // logs and skips the stop instead of propagating.
              const shouldStopSessionAfterCommand = archiveCommand
                ? yield* projectionSnapshotQuery.getThreadShellById(archiveCommand.threadId).pipe(
                    Effect.map(
                      Option.match({
                        onNone: () => false,
                        onSome: (thread) =>
                          thread.session !== null && thread.session.status !== "stopped",
                      }),
                    ),
                    Effect.catchCause((cause) =>
                      Effect.logWarning(
                        "failed to read thread session state before session-stop check",
                        { threadId: archiveCommand.threadId, cause },
                      ).pipe(Effect.as(false)),
                    ),
                  )
                : false;
              const result = yield* dispatchNormalizedCommand(normalizedCommand).pipe(
                Effect.tapError(() => cleanupFailedUploadedAttachments(command, normalizedCommand)),
              );
              yield* recordClientCommandAnalytics(normalizedCommand);
              if (archiveCommand) {
                if (shouldStopSessionAfterCommand) {
                  yield* Effect.gen(function* () {
                    const stopCommand = yield* normalizeDispatchCommand({
                      type: "thread.session.stop",
                      commandId: CommandId.make(
                        `session-stop-for-archive:${archiveCommand.commandId}`,
                      ),
                      threadId: archiveCommand.threadId,
                      createdAt: yield* nowIso,
                    });

                    yield* dispatchNormalizedCommand(stopCommand);
                  }).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning("failed to stop provider session during archive", {
                        threadId: archiveCommand.threadId,
                        cause,
                      }),
                    ),
                  );
                }

                // Archive removes the thread from view, so its user-opened
                // terminal panes close with it.
                yield* terminalManager.close({ threadId: archiveCommand.threadId }).pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("failed to close thread terminals after archive", {
                      threadId: archiveCommand.threadId,
                      error: error.message,
                    }),
                  ),
                );
              }
              return result;
            }).pipe(
              Effect.mapError((cause) =>
                isOrchestrationDispatchCommandError(cause)
                  ? cause
                  : new OrchestrationDispatchCommandError({
                      message: "Failed to dispatch orchestration command",
                      cause,
                    }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getWorkflowScript]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getWorkflowScript,
            readWorkflowScript({ scriptPath: input.scriptPath }),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getTurnDiff]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getTurnDiff,
            checkpointDiffQuery.getTurnDiff(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetTurnDiffError({
                    message: "Failed to load turn diff",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getFullThreadDiff,
            checkpointDiffQuery.getFullThreadDiff(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetFullThreadDiffError({
                    message: "Failed to load full thread diff",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.searchThreads]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.searchThreads,
            projectionSnapshotQuery.searchThreads(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationSearchThreadsError({
                    message: "Failed to search threads",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.subscribeShell]: (input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_WS_METHODS.subscribeShell,
            Effect.gen(function* () {
              // Coalesce the live shell stream per aggregate over a small window
              // so bursts of high-frequency events (streaming message deltas,
              // activity appends) collapse into a single shell refetch and never
              // serialize a brand-new thread's `thread.created` behind hundreds
              // of per-event DB reads. See coalesceShellStream.
              // Attach live delivery into a scope-bound buffer BEFORE loading any
              // snapshot or draining catch-up, otherwise an event published while
              // the snapshot query is in flight is lost (it is past the snapshot's
              // sequence but the live subscription is not attached yet). Every
              // path below emits from this same buffered live tail. Overlapping
              // events are deduped by sequence on the client.
              const liveBudget = yield* makeLiveStreamBudget();
              const liveBuffer = yield* Queue.unbounded<
                RetainedLiveItem<ShellLiveInput>,
                OrchestrationGetSnapshotError
              >();
              let liveBufferClosed = false;
              const closeLiveBuffer = (error?: OrchestrationGetSnapshotError) =>
                Effect.gen(function* () {
                  if (liveBufferClosed) {
                    return;
                  }
                  liveBufferClosed = true;
                  liveBudget.release(yield* Queue.clear(liveBuffer).pipe(Effect.orDie));
                  if (error) {
                    yield* Queue.fail(liveBuffer, error);
                  }
                  yield* Queue.shutdown(liveBuffer);
                });
              yield* Effect.addFinalizer(() => closeLiveBuffer());
              yield* liveBudget.failed.pipe(
                Effect.catchTags({ OrchestrationGetSnapshotError: closeLiveBuffer }),
                Effect.forkScoped,
              );
              yield* Effect.forkScoped(
                orchestrationEngine.streamDomainEvents.pipe(
                  Stream.runForEach((event) =>
                    liveBudget.retain({ kind: "event" as const, event }, event).pipe(
                      Effect.flatMap((item) => Queue.offer(liveBuffer, item)),
                      Effect.uninterruptible,
                    ),
                  ),
                  // Stop the PubSub consumer even if RPC delivery is waiting
                  // for an ACK and never pulls the failed buffer again.
                  Effect.raceFirst(liveBudget.failed),
                  Effect.catchTags({ OrchestrationGetSnapshotError: () => Effect.void }),
                ),
                { startImmediately: true },
              );
              const coalesceRetainedInputs = (
                items: ReadonlyArray<RetainedLiveItem<ShellLiveInput>>,
              ) =>
                coalesceShellLiveInputs(items.map((item) => item.value)).pipe(
                  Effect.flatMap((output) => liveBudget.replace(items, output)),
                );
              const bufferedLiveStream = Stream.fromQueue(liveBuffer).pipe(
                Stream.groupedWithin(SHELL_COALESCE_MAX_CHUNK, SHELL_COALESCE_WINDOW),
                Stream.mapEffect(coalesceRetainedInputs),
                Stream.flatMap((items) => Stream.fromIterable(items)),
              );

              const loadSnapshot = projectionSnapshotQuery.getShellSnapshot().pipe(
                Effect.tapError((cause) =>
                  Effect.logError("orchestration shell snapshot load failed", { cause }),
                ),
                Effect.mapError(
                  (cause) =>
                    new OrchestrationGetSnapshotError({
                      message: "Failed to load orchestration shell snapshot",
                      cause,
                    }),
                ),
              );

              // Offer the completion marker into the same queue as live events.
              // Anything buffered while snapshot/replay work was in flight is
              // therefore delivered before the client is told it is synchronized.
              const synchronizedThenLive = liveBudget.deliver(
                input.requestCompletionMarker === true
                  ? Stream.concat(
                      Stream.fromEffect(
                        liveBudget.retain({ kind: "synchronized" as const }).pipe(
                          Effect.flatMap((item) => Queue.offer(liveBuffer, item)),
                          Effect.uninterruptible,
                          Effect.andThen(Queue.takeAll(liveBuffer)),
                          Effect.flatMap(coalesceRetainedInputs),
                        ),
                      ).pipe(Stream.flatMap((items) => Stream.fromIterable(items))),
                      bufferedLiveStream,
                    )
                  : bufferedLiveStream,
              );

              // When the client already holds a shell snapshot (cached, or loaded
              // over HTTP) it passes that snapshot's sequence, and we resume by
              // replaying shell events after it instead of re-sending the whole
              // projects/threads list over the socket. If the client is too far
              // behind, we fall back to a fresh snapshot instead of an unbounded
              // replay (see below).
              if (input.afterSequence !== undefined) {
                const afterSequence = input.afterSequence;
                const headSequence = yield* orchestrationEngine.latestSequence;
                const replayGap = headSequence - afterSequence;
                // Gap too large: replaying every intervening event (each a shell
                // refetch) is far more expensive than a single O(active-threads)
                // snapshot. A cursor ahead of this engine's authoritative state
                // is also invalid, so reset it with a snapshot. Send the snapshot
                // followed by the buffered live tail, exactly as the
                // no-afterSequence path does.
                if (
                  !(yield* canReplayPersistedRange(
                    afterSequence,
                    headSequence,
                    SHELL_RESUME_MAX_GAP,
                  ))
                ) {
                  const snapshot = yield* loadSnapshot;
                  return Stream.concat(
                    Stream.make({ kind: "snapshot" as const, snapshot }),
                    synchronizedThenLive,
                  );
                }
                const catchUpStream = coalesceShellStream(
                  // Replay only through the head captured above. Newer events
                  // are already covered by the live subscription, so this bound
                  // cannot chase a moving event-store head or grow the live
                  // buffer indefinitely while waiting for an empty page.
                  orchestrationEngine.readEvents(afterSequence, replayGap),
                ).pipe(
                  Stream.mapError(
                    (cause) =>
                      new OrchestrationGetSnapshotError({
                        message: "Failed to replay orchestration shell events",
                        cause,
                      }),
                  ),
                );
                return Stream.concat(catchUpStream, synchronizedThenLive);
              }

              const snapshot = yield* loadSnapshot;
              return Stream.concat(
                Stream.make({
                  kind: "snapshot" as const,
                  snapshot,
                }),
                synchronizedThenLive,
              );
            }),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot]: (_input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
            projectionSnapshotQuery.getArchivedShellSnapshot().pipe(
              Effect.tapError((cause) =>
                Effect.logError("orchestration archived shell snapshot load failed", { cause }),
              ),
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({
                    message: "Failed to load archived orchestration shell snapshot",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.subscribeThread]: (input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_WS_METHODS.subscribeThread,
            Effect.gen(function* () {
              const isThisThreadDetailEvent = (event: OrchestrationEvent) =>
                event.aggregateKind === "thread" &&
                event.aggregateId === input.threadId &&
                isThreadDetailEvent(event);

              const liveStream = orchestrationEngine.streamDomainEvents.pipe(
                Stream.filter(isThisThreadDetailEvent),
                Stream.map((event) => ({
                  kind: "event" as const,
                  event,
                })),
              );

              // Attach live delivery before reading either replay or snapshot state.
              // Otherwise an event published while the snapshot is loading is lost.
              const liveBuffer = yield* makeThreadLiveEventCoalescer();
              yield* Effect.forkScoped(
                liveStream.pipe(
                  Stream.runForEachArray(liveBuffer.offerAll),
                  Effect.raceFirst(liveBuffer.failed),
                  Effect.catchTags({ OrchestrationGetSnapshotError: () => Effect.void }),
                ),
                { startImmediately: true },
              );
              const bufferedLiveStream = liveBuffer.stream;
              let replayOnMissingSnapshot: typeof bufferedLiveStream | undefined;

              // When the client already loaded the snapshot over HTTP it passes
              // that snapshot's sequence, and we resume the live subscription by
              // replaying persisted events after it instead of re-sending the
              // (potentially multi-KB) snapshot frame over the socket.
              //
              // The live PubSub subscription must be attached *before* draining
              // the catch-up replay, otherwise events published during the replay
              // window are dropped (they are past the persisted tail the replay
              // read, but the live stream is not yet subscribed). So fork the
              // live stream into a buffer bound to this stream's scope, then emit
              // catch-up followed by the buffered/ongoing live events. Overlapping
              // events are deduped by sequence on the client.
              //
              // Measure only this thread's rows. Global sequence gaps can
              // contain unrelated or pruned streams. Keep an explicit upper
              // bound so events after the captured head stay in the live tail.
              if (input.afterSequence !== undefined) {
                const afterSequence = input.afterSequence;
                const headSequence = yield* orchestrationEngine.latestSequence;
                const range = {
                  threadId: input.threadId,
                  fromSequenceExclusive: afterSequence,
                  toSequenceInclusive: headSequence,
                };
                const replayStats =
                  afterSequence > headSequence
                    ? null
                    : yield* orchestrationEngine
                        .getThreadReplayStats({
                          ...range,
                          maxEvents: THREAD_RESUME_MAX_EVENTS,
                        })
                        .pipe(
                          Effect.mapError(
                            (cause) =>
                              new OrchestrationGetSnapshotError({
                                message: `Failed to measure thread ${input.threadId} replay range`,
                                cause,
                              }),
                          ),
                        );
                if (
                  replayStats !== null &&
                  replayStats.eventCount <= THREAD_RESUME_MAX_EVENTS &&
                  replayStats.payloadBytes <= ORCHESTRATION_REPLAY_PAYLOAD_BUDGET_BYTES
                ) {
                  const catchUpStream = orchestrationEngine
                    .readThreadEvents({ ...range, limit: THREAD_RESUME_MAX_EVENTS })
                    .pipe(
                      Stream.filter(isThisThreadDetailEvent),
                      Stream.map((event) => ({
                        kind: "event" as const,
                        event: projectActivityEvent(event),
                      })),
                      Stream.mapError(
                        (cause) =>
                          new OrchestrationGetSnapshotError({
                            message: `Failed to replay thread ${input.threadId} events`,
                            cause,
                          }),
                      ),
                    );
                  const afterCatchUp =
                    input.requestCompletionMarker === true
                      ? Stream.unwrap(
                          liveBuffer
                            .offer({ kind: "synchronized" as const })
                            .pipe(Effect.as(bufferedLiveStream)),
                        )
                      : bufferedLiveStream;
                  const replay = Stream.concat(catchUpStream, afterCatchUp);
                  if (!replayStats.hasCreateEvent) {
                    return replay;
                  }
                  replayOnMissingSnapshot = replay;
                }
                // A recreated thread needs a fresh snapshot if it still exists.
                // Oversized replays and invalid cursors also use the snapshot path.
              }

              const snapshot = yield* projectionSnapshotQuery
                .getThreadDetailSnapshot(
                  input.threadId,
                  // Windowing the fallback snapshot is opt-in per subscription:
                  // clients that don't send turnLimit (including all
                  // pre-pagination clients) get the full thread, since they
                  // have no way to load older pages.
                  input.turnLimit === undefined ? undefined : { turnLimit: input.turnLimit },
                )
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationGetSnapshotError({
                        message: `Failed to load thread ${input.threadId}`,
                        cause,
                      }),
                  ),
                );

              if (Option.isNone(snapshot)) {
                // The recreated thread can already be deleted. Preserve the
                // bounded replay and shell removal instead of retrying a
                // snapshot that cannot exist. Oversized ranges still fail.
                if (replayOnMissingSnapshot !== undefined) {
                  return replayOnMissingSnapshot;
                }
                return yield* new OrchestrationGetSnapshotError({
                  message: `Thread ${input.threadId} was not found`,
                  cause: input.threadId,
                });
              }

              const afterSnapshot =
                input.requestCompletionMarker === true
                  ? Stream.unwrap(
                      liveBuffer
                        .offer({ kind: "synchronized" as const })
                        .pipe(Effect.as(bufferedLiveStream)),
                    )
                  : bufferedLiveStream;
              return Stream.concat(
                Stream.make({
                  kind: "snapshot" as const,
                  snapshot: projectThreadDetailSnapshot(snapshot.value),
                }),
                afterSnapshot,
              );
            }),
            { "rpc.aggregate": "orchestration" },
          ),
        [WS_METHODS.serverProbe]: (_input) =>
          observeRpcEffect(WS_METHODS.serverProbe, Effect.succeed({}), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverGetConfig]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetConfig, loadServerConfig, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverRefreshProviders]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverRefreshProviders,
            Effect.gen(function* () {
              // An untargeted refresh is "re-read everything's status", which
              // includes quota from configured usage-limit sources. Awaited,
              // not forked: the RPC scope closes on return and would
              // interrupt a fork before the hub answered.
              if (input.instanceId === undefined) {
                yield* usageLimitSources.refresh;
              }
              let providers = yield* input.cwd !== undefined && input.instanceId !== undefined
                ? providerRegistry.refreshWorkspaceSnapshot({
                    instanceId: input.instanceId,
                    cwd: input.cwd,
                  })
                : input.instanceId !== undefined
                  ? providerRegistry.refreshInstance(input.instanceId)
                  : providerRegistry.refresh();
              if (input.refreshModels) {
                const instances = yield* providerInstances.listInstances;
                for (const instance of instances) {
                  if (
                    !instance.refreshModels ||
                    (input.instanceId !== undefined && input.instanceId !== instance.instanceId) ||
                    !providers.some(
                      (provider) =>
                        provider.instanceId === instance.instanceId &&
                        provider.enabled &&
                        provider.installed,
                    )
                  )
                    continue;
                  yield* instance.refreshModels().pipe(
                    Effect.mapError(
                      (error) =>
                        new ProviderSetupError({
                          instanceId: instance.instanceId,
                          operation: "refresh-models",
                          detail: error.detail,
                        }),
                    ),
                  );
                  providers = yield* providerRegistry.refreshInstance(instance.instanceId);
                }
              }
              return { providers };
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.providerUploadFeedback]: (input) =>
          observeRpcEffect(
            WS_METHODS.providerUploadFeedback,
            providerService.uploadFeedback(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderUploadFeedbackError({
                    threadId: input.threadId,
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "provider" },
          ),
        [WS_METHODS.serverUpdateProvider]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverUpdateProvider,
            providerMaintenanceRunner.updateProvider(input),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.providerConsumeResetCredit]: (input) =>
          observeRpcEffect(
            WS_METHODS.providerConsumeResetCredit,
            Effect.gen(function* () {
              const instance = yield* providerInstances.getInstance(input.instanceId);
              // A disabled instance must not spend anything on its account.
              if (instance === undefined || !instance.enabled) {
                return yield* new ProviderSetupError({
                  instanceId: input.instanceId,
                  operation: "consume-reset-credit",
                  detail: instance ? "This provider is disabled." : "Provider instance not found.",
                });
              }
              if (instance.consumeResetCredit === undefined) {
                return yield* new ProviderSetupError({
                  instanceId: input.instanceId,
                  operation: "consume-reset-credit",
                  detail: "This provider does not bank reset credits.",
                });
              }
              const outcome = yield* instance.consumeResetCredit().pipe(
                Effect.mapError(
                  (error) =>
                    new ProviderSetupError({
                      instanceId: input.instanceId,
                      operation: "consume-reset-credit",
                      detail: error.detail,
                      cause: error,
                    }),
                ),
              );
              return { outcome };
            }),
            { "rpc.aggregate": "provider" },
          ),
        [WS_METHODS.providerAuthStart]: (input) =>
          observeRpcEffect(
            WS_METHODS.providerAuthStart,
            providerAuth.start(input, currentSessionId),
            { "rpc.aggregate": "provider" },
          ),
        [WS_METHODS.providerAuthComplete]: (input) =>
          observeRpcEffect(
            WS_METHODS.providerAuthComplete,
            providerAuth.complete(input, currentSessionId),
            { "rpc.aggregate": "provider" },
          ),
        [WS_METHODS.providerAuthCancel]: (input) =>
          observeRpcEffect(
            WS_METHODS.providerAuthCancel,
            providerAuth.cancel(input, currentSessionId),
            { "rpc.aggregate": "provider" },
          ),
        [WS_METHODS.providerAuthLogout]: (input) =>
          observeRpcEffect(WS_METHODS.providerAuthLogout, providerAuth.logout(input), {
            "rpc.aggregate": "provider",
          }),
        [WS_METHODS.providerAuthSubscribe]: (input) =>
          observeRpcStream(
            WS_METHODS.providerAuthSubscribe,
            providerAuth.subscribe(input, currentSessionId),
            { "rpc.aggregate": "provider" },
          ),
        [WS_METHODS.providerInstallStart]: (input) =>
          observeRpcEffect(WS_METHODS.providerInstallStart, providerInstallation.start(input), {
            "rpc.aggregate": "provider",
          }),
        [WS_METHODS.providerInstallCancel]: (input) =>
          observeRpcEffect(WS_METHODS.providerInstallCancel, providerInstallation.cancel(input), {
            "rpc.aggregate": "provider",
          }),
        [WS_METHODS.providerInstallSubscribe]: (input) =>
          observeRpcStream(
            WS_METHODS.providerInstallSubscribe,
            providerInstallation.subscribe(input),
            { "rpc.aggregate": "provider" },
          ),
        [WS_METHODS.providerInstallRemove]: (input) =>
          observeRpcEffect(WS_METHODS.providerInstallRemove, providerInstallation.remove(input), {
            "rpc.aggregate": "provider",
          }),
        [WS_METHODS.serverUpdateServer]: (input) =>
          observeRpcEffect(WS_METHODS.serverUpdateServer, serverUpdate.update(input), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverUpdateServerWithProgress]: (input) =>
          observeRpcStream(
            WS_METHODS.serverUpdateServerWithProgress,
            Stream.callback<ServerSelfUpdateProgressEvent, ServerSelfUpdateError>((queue) =>
              serverUpdate
                .update(input, (stage) =>
                  Queue.offer(queue, {
                    type: "progress",
                    stage,
                  }).pipe(Effect.asVoid),
                )
                .pipe(
                  Effect.flatMap((result) =>
                    Queue.offer(queue, {
                      type: "complete",
                      result,
                    }),
                  ),
                  Effect.catchTags({
                    ServerSelfUpdateError: (error) => Queue.fail(queue, error),
                  }),
                  Effect.andThen(Queue.end(queue)),
                  Effect.forkScoped,
                ),
            ),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverCommitDesktopUpdate]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverCommitDesktopUpdate,
            serverUpdate.commitDesktopUpdate(input.requestId),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverUpsertKeybinding]: (rule) =>
          observeRpcEffect(
            WS_METHODS.serverUpsertKeybinding,
            Effect.gen(function* () {
              const keybindingsConfig = yield* keybindings.upsertKeybindingRule(rule);
              return { keybindings: keybindingsConfig, issues: [] };
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverRemoveKeybinding]: (rule) =>
          observeRpcEffect(
            WS_METHODS.serverRemoveKeybinding,
            Effect.gen(function* () {
              const keybindingsConfig = yield* keybindings.removeKeybindingRule(rule);
              return { keybindings: keybindingsConfig, issues: [] };
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverGetSettings]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverGetSettings,
            serverSettings.getSettings.pipe(
              Effect.map(ServerSettings.redactServerSettingsForClient),
            ),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverUpdateSettings]: ({ patch }) =>
          observeRpcEffect(
            WS_METHODS.serverUpdateSettings,
            serverSettings
              .updateSettings(patch)
              .pipe(Effect.map(ServerSettings.redactServerSettingsForClient)),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.providerCapabilitiesGet]: ({ instanceId }) =>
          observeRpcEffect(
            WS_METHODS.providerCapabilitiesGet,
            Effect.gen(function* () {
              const instance = yield* providerInstances.getInstance(instanceId);
              if (!instance) {
                return yield* new ProviderCapabilityInventoryError({
                  instanceId,
                  message: `Provider instance '${instanceId}' was not found.`,
                });
              }
              const snapshot = yield* instance.snapshot.getSnapshot;
              const mcpServers = instance.discoverMcpServers
                ? yield* instance.discoverMcpServers().pipe(
                    Effect.mapError(
                      (cause) =>
                        new ProviderCapabilityInventoryError({
                          instanceId,
                          message: cause.message,
                        }),
                    ),
                  )
                : [];
              return {
                instanceId,
                driver: instance.driverKind,
                checkedAt: snapshot.checkedAt,
                mcpServers,
                skills: snapshot.skills,
                mcpDiscoverySupported: instance.discoverMcpServers !== undefined,
              };
            }),
            { "rpc.aggregate": "provider" },
          ),
        [WS_METHODS.axisContextsGetCatalog]: (_input) =>
          observeRpcEffect(WS_METHODS.axisContextsGetCatalog, axisContextCatalog.get, {
            "rpc.aggregate": "axis",
          }),
        [WS_METHODS.axisContextsReplaceCatalog]: (input) =>
          observeRpcEffect(
            WS_METHODS.axisContextsReplaceCatalog,
            axisContextCatalog.replace(input),
            { "rpc.aggregate": "axis" },
          ),
        [WS_METHODS.axisWorkHubGetCache]: (_input) =>
          observeRpcEffect(WS_METHODS.axisWorkHubGetCache, axisWorkHubCache.list, {
            "rpc.aggregate": "axis",
          }),
        [WS_METHODS.axisWorkHubGetSourceStatuses]: (_input) =>
          observeRpcEffect(WS_METHODS.axisWorkHubGetSourceStatuses, axisWorkHubCache.listStatuses, {
            "rpc.aggregate": "axis",
          }),
        [WS_METHODS.providerWorkHubCollect]: ({ sourceId }) =>
          observeRpcEffect(
            WS_METHODS.providerWorkHubCollect,
            axisWorkHubSourceSync
              .sync(sourceId, "manual")
              .pipe(Effect.map((outcome) => outcome.snapshot)),
            { "rpc.aggregate": "axis" },
          ),
        [WS_METHODS.axisScheduledActivitiesList]: (_input) =>
          observeRpcEffect(WS_METHODS.axisScheduledActivitiesList, axisScheduledActivities.list, {
            "rpc.aggregate": "axis",
          }),
        [WS_METHODS.axisScheduledActivitiesCreate]: ({ activity }) =>
          observeRpcEffect(
            WS_METHODS.axisScheduledActivitiesCreate,
            axisScheduledActivities.create(activity),
            { "rpc.aggregate": "axis" },
          ),
        [WS_METHODS.axisScheduledActivitiesUpdate]: ({ activity }) =>
          observeRpcEffect(
            WS_METHODS.axisScheduledActivitiesUpdate,
            axisScheduledActivities.update(activity),
            { "rpc.aggregate": "axis" },
          ),
        [WS_METHODS.axisScheduledActivitiesDelete]: ({ id }) =>
          observeRpcEffect(
            WS_METHODS.axisScheduledActivitiesDelete,
            axisScheduledActivities.remove(id),
            { "rpc.aggregate": "axis" },
          ),
        [WS_METHODS.axisScheduledActivitiesRunNow]: ({ id }) =>
          observeRpcEffect(
            WS_METHODS.axisScheduledActivitiesRunNow,
            axisScheduledActivities.runNow(id),
            { "rpc.aggregate": "axis" },
          ),
        [WS_METHODS.axisScheduledActivitiesListRuns]: ({ activityId, limit }) =>
          observeRpcEffect(
            WS_METHODS.axisScheduledActivitiesListRuns,
            axisScheduledActivities.listRuns(activityId, limit),
            { "rpc.aggregate": "axis" },
          ),
        [WS_METHODS.axisOnboardingList]: ({ scope }) =>
          observeRpcEffect(
            WS_METHODS.axisOnboardingList,
            validateProjectScope(scope, "read").pipe(
              Effect.flatMap((resolvedScope) =>
                requireAxisOnboarding().pipe(
                  Effect.flatMap((service) => service.list(resolvedScope)),
                ),
              ),
              Effect.mapError(onboardingRpcError),
            ),
            { "rpc.aggregate": "axis" },
          ),
        [WS_METHODS.axisOnboardingGet]: ({ scope, runId }) =>
          observeRpcEffect(
            WS_METHODS.axisOnboardingGet,
            validateProjectScope(scope, "read").pipe(
              Effect.flatMap((resolvedScope) =>
                requireAxisOnboarding().pipe(
                  Effect.flatMap((service) => service.get(resolvedScope, runId)),
                ),
              ),
              Effect.mapError(onboardingRpcError),
            ),
            { "rpc.aggregate": "axis" },
          ),
        [WS_METHODS.axisOnboardingStart]: (input) =>
          observeRpcEffect(
            WS_METHODS.axisOnboardingStart,
            validateProjectScope(input.scope, "write").pipe(
              Effect.flatMap((resolvedScope) =>
                axisContextProjectScopeKey(resolvedScope) ===
                axisContextProjectScopeKey(input.scope)
                  ? requireAxisOnboarding().pipe(
                      Effect.flatMap((service) =>
                        service.start({ ...input, scope: resolvedScope }),
                      ),
                    )
                  : Effect.fail(
                      new AxisProjectProfileValidationError({
                        message: "The onboarding project scope changed during validation.",
                      }),
                    ),
              ),
              Effect.mapError(onboardingRpcError),
            ),
            { "rpc.aggregate": "axis" },
          ),
        [WS_METHODS.axisOnboardingCancel]: ({ scope, input }) =>
          observeRpcEffect(
            WS_METHODS.axisOnboardingCancel,
            validateProjectScope(scope, "write").pipe(
              Effect.flatMap((resolvedScope) =>
                requireAxisOnboarding().pipe(
                  Effect.flatMap((service) => service.cancel(resolvedScope, input)),
                ),
              ),
              Effect.mapError(onboardingRpcError),
            ),
            { "rpc.aggregate": "axis" },
          ),
        [WS_METHODS.axisOnboardingRetry]: ({ scope, input }) =>
          observeRpcEffect(
            WS_METHODS.axisOnboardingRetry,
            validateProjectScope(scope, "write").pipe(
              Effect.flatMap((resolvedScope) =>
                requireAxisOnboarding().pipe(
                  Effect.flatMap((service) => service.retry(resolvedScope, input)),
                ),
              ),
              Effect.mapError(onboardingRpcError),
            ),
            { "rpc.aggregate": "axis" },
          ),
        [WS_METHODS.axisOnboardingApply]: (input) =>
          observeRpcEffect(
            WS_METHODS.axisOnboardingApply,
            validateProjectScope(input.scope, "write").pipe(
              Effect.flatMap((resolvedScope) =>
                axisContextProjectScopeKey(resolvedScope) ===
                axisContextProjectScopeKey(input.scope)
                  ? requireAxisOnboarding().pipe(
                      Effect.flatMap((service) =>
                        service.apply({ ...input, scope: resolvedScope }),
                      ),
                    )
                  : Effect.fail(
                      new AxisProjectProfileValidationError({
                        message: "The onboarding project scope changed during validation.",
                      }),
                    ),
              ),
              Effect.mapError(onboardingRpcError),
            ),
            { "rpc.aggregate": "axis" },
          ),
        [WS_METHODS.axisLearningGetSnapshot]: ({ contextId, scope }) =>
          observeRpcEffect(
            WS_METHODS.axisLearningGetSnapshot,
            validateLearningContext(contextId, scope).pipe(
              Effect.flatMap((validatedScope) => validateLearningScope(validatedScope, "read")),
              Effect.flatMap((validatedScope) =>
                axisLearning.getSnapshot(contextId, validatedScope),
              ),
            ),
            { "rpc.aggregate": "axis" },
          ),
        [WS_METHODS.axisLearningRequestImprovements]: (input) =>
          observeRpcEffect(
            WS_METHODS.axisLearningRequestImprovements,
            validateProjectScope(input.scope, "write").pipe(
              Effect.flatMap((validatedScope) =>
                axisContextProjectScopeKey(validatedScope) !==
                axisContextProjectScopeKey(input.scope)
                  ? Effect.fail(
                      new AxisProjectProfileValidationError({
                        message: "The Learning project scope changed during validation.",
                      }),
                    )
                  : Option.match(axisLearningService, {
                      onNone: () =>
                        Effect.succeed({
                          id: `axis-learning-unavailable-${input.commandId.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
                          status: "unavailable" as const,
                          commandId: input.commandId,
                          engine: {
                            availability: "absent" as const,
                            message: "No Axis learning engine is configured.",
                          },
                          proposals: [],
                          reason: "No Axis learning engine is configured.",
                        }),
                      onSome: (service) =>
                        service.requestImprovements({ ...input, scope: validatedScope }),
                    }),
              ),
            ),
            { "rpc.aggregate": "axis" },
          ),
        [WS_METHODS.axisLearningRecordEvidence]: ({ evidence, scope }) =>
          observeRpcEffect(
            WS_METHODS.axisLearningRecordEvidence,
            validateLearningPayloadScope(
              evidence.provenance.contextId,
              evidence.provenance.scope,
              scope,
              "write",
            ).pipe(
              Effect.flatMap((validatedScope) =>
                nowIso.pipe(
                  Effect.flatMap((createdAt) =>
                    axisLearning.recordEvidence({
                      ...evidence,
                      ...(validatedScope === undefined
                        ? {}
                        : { provenance: { ...evidence.provenance, scope: validatedScope } }),
                      createdAt,
                    }),
                  ),
                ),
              ),
            ),
            { "rpc.aggregate": "axis" },
          ),
        [WS_METHODS.axisLearningCreateProposal]: ({ proposal, scope }) =>
          observeRpcEffect(
            WS_METHODS.axisLearningCreateProposal,
            validateLearningPayloadScope(proposal.contextId, proposal.scope, scope, "write").pipe(
              Effect.flatMap((validatedScope) =>
                nowIso.pipe(
                  Effect.flatMap((createdAt) =>
                    axisLearning.createProposal(
                      validatedScope === undefined
                        ? proposal
                        : { ...proposal, scope: validatedScope },
                      createdAt,
                    ),
                  ),
                ),
              ),
            ),
            { "rpc.aggregate": "axis" },
          ),
        [WS_METHODS.axisLearningSubmitProposal]: ({ id, scope }) =>
          observeRpcEffect(
            WS_METHODS.axisLearningSubmitProposal,
            validateLearningEntityScope(id, scope, "write").pipe(
              Effect.flatMap((lookup) =>
                learningReviewInput().pipe(
                  Effect.flatMap((input) => axisLearning.submitForReview(id, lookup, input)),
                ),
              ),
            ),
            { "rpc.aggregate": "axis" },
          ),
        [WS_METHODS.axisLearningApproveProposal]: ({ id, note, scope }) =>
          observeRpcEffect(
            WS_METHODS.axisLearningApproveProposal,
            validateLearningEntityScope(id, scope, "write").pipe(
              Effect.flatMap((lookup) =>
                Effect.all({
                  input: learningReviewInput(note),
                  versionId: learningRandomUUID.pipe(Effect.map(AxisLearningVersionId.make)),
                }).pipe(
                  Effect.flatMap(({ input, versionId }) =>
                    axisLearning.approve(id, lookup, versionId, input),
                  ),
                ),
              ),
            ),
            { "rpc.aggregate": "axis" },
          ),
        [WS_METHODS.axisLearningRejectProposal]: ({ id, note, scope }) =>
          observeRpcEffect(
            WS_METHODS.axisLearningRejectProposal,
            validateLearningEntityScope(id, scope, "write").pipe(
              Effect.flatMap((lookup) =>
                learningReviewInput(note).pipe(
                  Effect.flatMap((input) => axisLearning.reject(id, lookup, input)),
                ),
              ),
            ),
            { "rpc.aggregate": "axis" },
          ),
        [WS_METHODS.axisLearningActivateVersion]: ({
          id,
          scope,
          targetKey,
          versionId,
          expectedRevision,
          commandId,
        }) =>
          observeRpcEffect(
            WS_METHODS.axisLearningActivateVersion,
            Effect.gen(function* () {
              if (
                scope === undefined ||
                targetKey === undefined ||
                expectedRevision === undefined ||
                commandId === undefined
              ) {
                return yield* new AxisLearningRevisionRequiredError({
                  message: "Activation requires scope, target, expectedRevision, and commandId.",
                });
              }
              const validatedScope = yield* validateRequiredLearningScope(scope, "write");
              return yield* axisLearning.activate(
                validatedScope,
                targetKey,
                versionId ?? id,
                expectedRevision,
                commandId,
              );
            }),
            { "rpc.aggregate": "axis" },
          ),
        [WS_METHODS.axisLearningRollbackVersion]: ({
          id,
          scope,
          targetKey,
          versionId,
          expectedRevision,
          commandId,
        }) =>
          observeRpcEffect(
            WS_METHODS.axisLearningRollbackVersion,
            Effect.gen(function* () {
              if (
                scope === undefined ||
                targetKey === undefined ||
                expectedRevision === undefined ||
                commandId === undefined
              ) {
                return yield* new AxisLearningRevisionRequiredError({
                  message: "Rollback requires scope, target, expectedRevision, and commandId.",
                });
              }
              const validatedScope = yield* validateRequiredLearningScope(scope, "write");
              return yield* axisLearning.rollback(
                validatedScope,
                targetKey,
                versionId ?? id,
                expectedRevision,
                commandId,
              );
            }),
            { "rpc.aggregate": "axis" },
          ),
        [WS_METHODS.axisLearningDeactivateVersion]: ({
          scope,
          targetKey,
          expectedRevision,
          commandId,
          note,
        }) =>
          observeRpcEffect(
            WS_METHODS.axisLearningDeactivateVersion,
            validateRequiredLearningScope(scope, "write").pipe(
              Effect.flatMap((validatedScope) =>
                axisLearning.deactivate(
                  validatedScope,
                  targetKey,
                  expectedRevision,
                  commandId,
                  note,
                ),
              ),
            ),
            { "rpc.aggregate": "axis" },
          ),
        [WS_METHODS.axisTasksList]: ({ scope }) =>
          observeRpcEffect(
            WS_METHODS.axisTasksList,
            validateTaskProjectScope(scope, "read").pipe(
              Effect.flatMap((resolved) => axisTasks.list(resolved)),
            ),
            { "rpc.aggregate": "axis" },
          ),
        [WS_METHODS.axisWorkflowStart]: (input) =>
          observeRpcEffect(
            WS_METHODS.axisWorkflowStart,
            workflowContext(input.scope).pipe(
              Effect.flatMap(({ caller, service }) => service.start(caller, input)),
            ),
            { "rpc.aggregate": "axis" },
          ),
        [WS_METHODS.axisWorkflowGet]: (input) =>
          observeRpcEffect(
            WS_METHODS.axisWorkflowGet,
            workflowContext(input.scope).pipe(
              Effect.flatMap(({ caller, service }) => service.get(caller, input)),
            ),
            { "rpc.aggregate": "axis" },
          ),
        [WS_METHODS.axisProjectContextPreview]: (input) =>
          observeRpcEffect(WS_METHODS.axisProjectContextPreview, projectContextPreview(input), {
            "rpc.aggregate": "axis",
          }),
        [WS_METHODS.axisWorkflowCancel]: (input) =>
          observeRpcEffect(
            WS_METHODS.axisWorkflowCancel,
            workflowContext(input.scope).pipe(
              Effect.flatMap(({ caller, service }) => service.cancel(caller, input)),
            ),
            { "rpc.aggregate": "axis" },
          ),
        [WS_METHODS.axisWorkflowRetry]: (input) =>
          observeRpcEffect(
            WS_METHODS.axisWorkflowRetry,
            workflowContext(input.scope).pipe(
              Effect.flatMap(({ caller, service }) => service.retry(caller, input)),
            ),
            { "rpc.aggregate": "axis" },
          ),
        [WS_METHODS.axisTaskFeedbackRecord]: (input) =>
          observeRpcEffect(
            WS_METHODS.axisTaskFeedbackRecord,
            taskFeedbackContext(input).pipe(
              Effect.flatMap(({ caller, service }) => service.record(caller, input)),
            ),
            { "rpc.aggregate": "axis" },
          ),
        [WS_METHODS.axisTasksGet]: ({ scope, threadId }) =>
          observeRpcEffect(
            WS_METHODS.axisTasksGet,
            validateTaskProjectScope(scope, "read").pipe(
              Effect.flatMap((resolved) => axisTasks.get(resolved, threadId)),
              Effect.map(Option.getOrNull),
            ),
            { "rpc.aggregate": "axis" },
          ),
        [WS_METHODS.axisTasksCreate]: ({ task, commandId }) =>
          observeRpcEffect(
            WS_METHODS.axisTasksCreate,
            validateTaskProjectScope(task.scope, "write").pipe(
              Effect.flatMap((resolved) =>
                axisTaskScopeMatchesValidatedScope(task.scope, resolved)
                  ? axisTasks.create(task, commandId)
                  : Effect.fail(
                      new AxisTaskValidationError({
                        message: "The task scope changed during validation.",
                      }),
                    ),
              ),
            ),
            { "rpc.aggregate": "axis" },
          ),
        [WS_METHODS.axisTasksUpdate]: (mutation) =>
          observeRpcEffect(
            WS_METHODS.axisTasksUpdate,
            validateTaskProjectScope(mutation.task.scope, "write").pipe(
              Effect.flatMap((resolved) =>
                axisContextProjectScopeKey(resolved) ===
                axisContextProjectScopeKey(mutation.task.scope)
                  ? axisTasks.update(mutation)
                  : Effect.fail(
                      new AxisTaskValidationError({
                        message: "The task scope changed during validation.",
                      }),
                    ),
              ),
            ),
            { "rpc.aggregate": "axis" },
          ),
        [WS_METHODS.axisTasksPause]: (input) =>
          observeRpcEffect(
            WS_METHODS.axisTasksPause,
            validateTaskProjectScope(input.scope, "write").pipe(
              Effect.flatMap((resolved) => axisTasks.pause({ ...input, scope: resolved })),
            ),
            { "rpc.aggregate": "axis" },
          ),
        [WS_METHODS.axisTasksReopen]: (input) =>
          observeRpcEffect(
            WS_METHODS.axisTasksReopen,
            validateTaskProjectScope(input.scope, "write").pipe(
              Effect.flatMap((resolved) => axisTasks.reopen({ ...input, scope: resolved })),
            ),
            { "rpc.aggregate": "axis" },
          ),
        [WS_METHODS.axisTasksUnlinkSource]: (input) =>
          observeRpcEffect(
            WS_METHODS.axisTasksUnlinkSource,
            validateTaskProjectScope(input.scope, "write").pipe(
              Effect.flatMap((resolved) => axisTasks.unlinkSource({ ...input, scope: resolved })),
            ),
            { "rpc.aggregate": "axis" },
          ),
        [WS_METHODS.axisProjectProfileGet]: ({ scope }) =>
          observeRpcEffect(
            WS_METHODS.axisProjectProfileGet,
            validateProjectScope(scope, "read").pipe(
              Effect.flatMap((validatedScope) =>
                requireProjectProfileStore().pipe(
                  Effect.flatMap((store) => store.get(validatedScope)),
                ),
              ),
            ),
            { "rpc.aggregate": "axis" },
          ),
        [WS_METHODS.axisProjectProfileReplace]: ({ scope, expectedRevision, changes }) =>
          observeRpcEffect(
            WS_METHODS.axisProjectProfileReplace,
            validateProjectScope(scope, "write").pipe(
              Effect.flatMap((validatedScope) =>
                requireProjectProfileStore().pipe(
                  Effect.flatMap((store) =>
                    store.replace(validatedScope, expectedRevision, changes),
                  ),
                ),
              ),
            ),
            { "rpc.aggregate": "axis" },
          ),
        [WS_METHODS.axisProjectProfileResetOverride]: ({ scope, ruleId, expectedRevision }) =>
          observeRpcEffect(
            WS_METHODS.axisProjectProfileResetOverride,
            validateProjectScope(scope, "write").pipe(
              Effect.flatMap((validatedScope) =>
                requireProjectProfileStore().pipe(
                  Effect.flatMap((store) =>
                    store.resetOverride(validatedScope, ruleId, expectedRevision),
                  ),
                ),
              ),
            ),
            { "rpc.aggregate": "axis" },
          ),
        [WS_METHODS.axisScratchChatsList]: ({ includeArchived }) =>
          observeRpcEffect(
            WS_METHODS.axisScratchChatsList,
            serverEnvironmentId.pipe(
              Effect.flatMap((environmentId) =>
                axisScratchChats.list({ environmentId, includeArchived }),
              ),
            ),
            { "rpc.aggregate": "axis" },
          ),
        [WS_METHODS.axisScratchChatsGet]: (input) =>
          observeRpcEffect(WS_METHODS.axisScratchChatsGet, axisScratchChats.get(input), {
            "rpc.aggregate": "axis",
          }),
        [WS_METHODS.axisScratchChatsCreate]: ({ draft }) =>
          observeRpcEffect(
            WS_METHODS.axisScratchChatsCreate,
            serverEnvironmentId.pipe(
              Effect.flatMap((environmentId) => axisScratchChats.create({ draft, environmentId })),
            ),
            { "rpc.aggregate": "axis" },
          ),
        [WS_METHODS.axisScratchChatsPatch]: (input) =>
          observeRpcEffect(WS_METHODS.axisScratchChatsPatch, axisScratchChats.patch(input), {
            "rpc.aggregate": "axis",
          }),
        [WS_METHODS.axisScratchChatsArchive]: (input) =>
          observeRpcEffect(WS_METHODS.axisScratchChatsArchive, axisScratchChats.archive(input), {
            "rpc.aggregate": "axis",
          }),
        [WS_METHODS.axisScratchChatsRemove]: (input) =>
          observeRpcEffect(WS_METHODS.axisScratchChatsRemove, axisScratchChats.remove(input), {
            "rpc.aggregate": "axis",
          }),
        [WS_METHODS.axisScratchChatsSendMessage]: (input) =>
          observeRpcEffect(
            WS_METHODS.axisScratchChatsSendMessage,
            axisScratchChats.sendMessage(input),
            { "rpc.aggregate": "axis" },
          ),
        [WS_METHODS.axisScratchChatsInterrupt]: (input) =>
          observeRpcEffect(
            WS_METHODS.axisScratchChatsInterrupt,
            axisScratchChats.interrupt(input),
            {
              "rpc.aggregate": "axis",
            },
          ),
        [WS_METHODS.axisScratchChatsSubscribe]: (input) =>
          observeRpcStreamEffect(
            WS_METHODS.axisScratchChatsSubscribe,
            axisScratchChats.subscribe(input),
            { "rpc.aggregate": "axis" },
          ),
        [WS_METHODS.serverDiscoverSourceControl]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverDiscoverSourceControl,
            sourceControlDiscovery.discover,
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverGetTraceDiagnostics]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverGetTraceDiagnostics,
            TraceDiagnostics.readTraceDiagnostics({
              traceFilePath: config.serverTracePath,
              maxFiles: config.traceMaxFiles,
            }),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverGetProcessDiagnostics]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetProcessDiagnostics, processDiagnostics.read, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverGetProcessResourceHistory]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverGetProcessResourceHistory,
            processResourceMonitor.readHistory(input),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverGetResourceTelemetryHistory]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverGetResourceTelemetryHistory,
            resourceTelemetry.readHistory(input),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverGetUsageSummary]: (input) =>
          observeRpcEffect(WS_METHODS.serverGetUsageSummary, usage.readSummary(input), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverGetTokenEfficiency]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverGetTokenEfficiency,
            tokenEfficiencyMetrics.getSnapshot,
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverRefreshUsageRates]: (_input) =>
          observeRpcEffect(WS_METHODS.serverRefreshUsageRates, usage.refreshRates, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverRetryResourceTelemetry]: (_input) =>
          observeRpcEffect(WS_METHODS.serverRetryResourceTelemetry, resourceTelemetry.retry, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverSignalProcess]: (input) =>
          observeRpcEffect(WS_METHODS.serverSignalProcess, processDiagnostics.signal(input), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverReportClientActivity]: (input, metadata) =>
          Ref.update(rpcClientIds, (clientIds) => {
            const next = new Set(clientIds);
            next.add(RpcClientId.make(metadata.client.id));
            return next;
          }).pipe(
            Effect.andThen(
              observeRpcEffect(
                WS_METHODS.serverReportClientActivity,
                backgroundPolicy.reportClientActivity(
                  currentSessionId,
                  RpcClientId.make(metadata.client.id),
                  input,
                ),
                { "rpc.aggregate": "server" },
              ),
            ),
          ),
        [WS_METHODS.serverReportHostPowerState]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverReportHostPowerState,
            backgroundPolicy.reportHostPowerState(input),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverGetBackgroundPolicy]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetBackgroundPolicy, backgroundPolicy.snapshot, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.cloudGetRelayClientStatus]: (_input) =>
          observeRpcEffect(WS_METHODS.cloudGetRelayClientStatus, relayClient.resolve, {
            "rpc.aggregate": "cloud",
          }),
        [WS_METHODS.cloudInstallRelayClient]: (_input) =>
          observeRpcStream(
            WS_METHODS.cloudInstallRelayClient,
            Stream.callback<RelayClientInstallProgressEvent, RelayClientInstallFailedError>(
              (queue) =>
                relayClient
                  .installWithProgress((event) => Queue.offer(queue, event).pipe(Effect.asVoid))
                  .pipe(
                    Effect.flatMap((status) =>
                      Queue.offer(queue, {
                        type: "complete",
                        status,
                      }),
                    ),
                    Effect.catchTag("RelayClientInstallError", (error) =>
                      Queue.fail(
                        queue,
                        new RelayClientInstallFailedError({
                          reason: error.reason,
                          message: error.message,
                        }),
                      ),
                    ),
                    Effect.andThen(Queue.end(queue)),
                    Effect.forkScoped,
                  ),
            ),
            { "rpc.aggregate": "cloud" },
          ),
        [WS_METHODS.pullRequestsList]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsList, pullRequests.list(input), {
            "rpc.aggregate": "pull-requests",
          }),
        [WS_METHODS.pullRequestsListStats]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsListStats, pullRequests.listStats(input), {
            "rpc.aggregate": "pull-requests",
          }),
        [WS_METHODS.pullRequestsSummary]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsSummary, pullRequests.summary(input), {
            "rpc.aggregate": "pull-requests",
          }),
        [WS_METHODS.pullRequestsDetail]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsDetail, pullRequests.detail(input), {
            "rpc.aggregate": "pull-requests",
          }),
        [WS_METHODS.pullRequestsActivity]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsActivity, pullRequests.activity(input), {
            "rpc.aggregate": "pull-requests",
          }),
        [WS_METHODS.pullRequestsThreadComments]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsThreadComments,
            pullRequests.threadComments(input),
            {
              "rpc.aggregate": "pull-requests",
            },
          ),
        [WS_METHODS.pullRequestsDiffFileContents]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsDiffFileContents,
            pullRequests.diffFileContents(input),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsRunAction]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsRunAction, pullRequests.runAction(input), {
            "rpc.aggregate": "pull-requests",
          }),
        [WS_METHODS.pullRequestsUpdate]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsUpdate, pullRequests.update(input), {
            "rpc.aggregate": "pull-requests",
          }),
        [WS_METHODS.pullRequestsComment]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsComment, pullRequests.comment(input), {
            "rpc.aggregate": "pull-requests",
          }),
        [WS_METHODS.pullRequestsUpdateComment]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsUpdateComment,
            pullRequests.updateComment(input),
            {
              "rpc.aggregate": "pull-requests",
            },
          ),
        [WS_METHODS.pullRequestsSubmitReview]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsSubmitReview, pullRequests.submitReview(input), {
            "rpc.aggregate": "pull-requests",
          }),
        [WS_METHODS.pullRequestsReplyToThread]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsReplyToThread,
            pullRequests.replyToThread(input),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsSetThreadResolution]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsSetThreadResolution,
            pullRequests.setThreadResolution(input),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsSetReaction]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsSetReaction, pullRequests.setReaction(input), {
            "rpc.aggregate": "pull-requests",
          }),
        [WS_METHODS.pullRequestsInvalidate]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsInvalidate, pullRequests.invalidate(input), {
            "rpc.aggregate": "pull-requests",
          }),
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () =>
          observeRpcStream(
            WS_METHODS.pullRequestsSubscribeRefreshes,
            pullRequests.subscribeRefreshes,
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsReviewerCandidates]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsReviewerCandidates,
            pullRequests.reviewerCandidates(input),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsRequestReviewers]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsRequestReviewers,
            pullRequests.requestReviewers(input),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsLabelCandidates]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsLabelCandidates,
            pullRequests.labelCandidates(input),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsSetLabels]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsSetLabels, pullRequests.setLabels(input), {
            "rpc.aggregate": "pull-requests",
          }),
        [WS_METHODS.sourceControlLookupRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlLookupRepository,
            sourceControlRepositories.lookupRepository(input),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.sourceControlCloneRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlCloneRepository,
            sourceControlRepositories.cloneRepository(input),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.sourceControlPublishRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlPublishRepository,
            (isAxisChatCwd(config.stateDir, input.cwd)
              ? Effect.fail(
                  new SourceControlRepositoryError({
                    operation: "publish",
                    provider: input.provider,
                    detail: "Chats does not support repositories.",
                  }),
                )
              : sourceControlRepositories.publishRepository(input)
            ).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.projectsSearchEntries]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsSearchEntries,
            workspaceEntries.search(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectSearchEntriesError({
                    cwd: input.cwd,
                    queryLength: input.query.length,
                    limit: input.limit,
                    ...projectEntriesFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsSearchContents]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsSearchContents,
            workspaceEntries.searchContents(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectSearchContentsError({
                    cwd: input.cwd,
                    queryLength: input.query.length,
                    limit: input.limit,
                    ...projectEntriesFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsListEntries]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsListEntries,
            workspaceEntries.list(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectListEntriesError({
                    ...input,
                    ...projectEntriesFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsReadFile]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsReadFile,
            workspaceFileSystem.readFile(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectReadFileError({
                    ...input,
                    ...projectFileFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsWriteFile]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsWriteFile,
            isAxisChatCwd(config.stateDir, input.cwd)
              ? Effect.fail(
                  new ProjectWriteFileError({
                    cwd: input.cwd,
                    relativePath: input.relativePath,
                    failure: "operation_failed",
                    cause: new Error("Chats cannot change workspace files."),
                  }),
                )
              : workspaceFileSystem.writeFile(input).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProjectWriteFileError({
                        cwd: input.cwd,
                        relativePath: input.relativePath,
                        ...projectFileFailureContext(cause),
                        cause,
                      }),
                  ),
                ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.shellOpenInEditor]: (input) =>
          observeRpcEffect(WS_METHODS.shellOpenInEditor, externalLauncher.launchEditor(input), {
            "rpc.aggregate": "workspace",
          }),
        [WS_METHODS.filesystemBrowse]: (input) =>
          observeRpcEffect(
            WS_METHODS.filesystemBrowse,
            workspaceEntries.browse(input).pipe(
              Effect.mapError(
                (cause) =>
                  new FilesystemBrowseError({
                    ...input,
                    ...filesystemBrowseFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.attachmentsCreateUploadUrl]: (input) =>
          observeRpcEffect(WS_METHODS.attachmentsCreateUploadUrl, issueAttachmentUploadUrl(input), {
            "rpc.aggregate": "workspace",
          }),
        [WS_METHODS.attachmentsDelete]: (input) =>
          observeRpcEffect(
            WS_METHODS.attachmentsDelete,
            deletePendingAttachment(input.attachmentId),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.assetsCreateUrl]: (input) =>
          observeRpcEffect(
            WS_METHODS.assetsCreateUrl,
            Effect.gen(function* () {
              if (
                input.resource._tag === "attachment" ||
                input.resource._tag === "native-app-icon"
              ) {
                return yield* issueAssetUrl({ resource: input.resource });
              }
              if (input.resource._tag === "project-favicon") {
                const project = yield* projectionSnapshotQuery
                  .getActiveProjectByWorkspaceRoot(input.resource.cwd)
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new AssetWorkspaceContextResolutionError({
                          resource: input.resource,
                          cause,
                        }),
                    ),
                  );
                if (Option.isNone(project)) {
                  return yield* new AssetWorkspaceContextNotFoundError({
                    resource: input.resource,
                  });
                }
                return yield* issueAssetUrl({
                  resource: input.resource,
                  ...(project.value.faviconPath
                    ? { projectFaviconPath: project.value.faviconPath }
                    : {}),
                });
              }
              const thread = yield* projectionSnapshotQuery
                .getThreadShellById(input.resource.threadId)
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new AssetWorkspaceContextResolutionError({
                        resource: input.resource,
                        cause,
                      }),
                  ),
                );
              if (Option.isNone(thread) || thread.value.projectId === null) {
                return yield* new AssetWorkspaceContextNotFoundError({
                  resource: input.resource,
                });
              }
              const project = yield* projectionSnapshotQuery
                .getProjectShellById(thread.value.projectId)
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new AssetWorkspaceContextResolutionError({
                        resource: input.resource,
                        cause,
                      }),
                  ),
                );
              if (Option.isNone(project)) {
                return yield* new AssetWorkspaceContextNotFoundError({
                  resource: input.resource,
                });
              }
              return yield* issueAssetUrl({
                resource: input.resource,
                workspaceRoot: thread.value.worktreePath ?? project.value.workspaceRoot,
              });
            }),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.subscribeVcsStatus]: (input) =>
          observeRpcStream(
            WS_METHODS.subscribeVcsStatus,
            isAxisChatCwd(config.stateDir, input.cwd)
              ? Stream.succeed<VcsStatusStreamEvent>({
                  _tag: "snapshot",
                  local: axisChatsVcsStatus,
                  remote: null,
                }).pipe(Stream.concat(Stream.never))
              : vcsStatusBroadcaster.streamStatus(input, {
                  automaticRemoteRefreshInterval: automaticGitFetchInterval,
                }),
            {
              "rpc.aggregate": "vcs",
            },
          ),
        [WS_METHODS.vcsRefreshStatus]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsRefreshStatus,
            isAxisChatCwd(config.stateDir, input.cwd)
              ? Effect.succeed(axisChatsVcsStatus)
              : vcsStatusBroadcaster.refreshStatus(input.cwd),
            {
              "rpc.aggregate": "vcs",
            },
          ),
        [WS_METHODS.vcsPull]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsPull,
            requireChatWorkspaceWritable(input.cwd).pipe(
              Effect.andThen(gitWorkflow.pullCurrentBranch(input.cwd)),
              Effect.matchCauseEffect({
                onFailure: (cause) => Effect.failCause(cause),
                onSuccess: (result) =>
                  refreshGitStatus(input.cwd).pipe(Effect.ignore({ log: true }), Effect.as(result)),
              }),
            ),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitRunStackedAction]: (input) =>
          observeRpcStream(
            WS_METHODS.gitRunStackedAction,
            Stream.callback<GitActionProgressEvent, GitManagerServiceError>((queue) =>
              requireChatWorkspaceWritable(input.cwd).pipe(
                Effect.andThen(
                  gitWorkflow.runStackedAction(input, {
                    actionId: input.actionId,
                    progressReporter: {
                      publish: (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
                    },
                  }),
                ),
                Effect.matchCauseEffect({
                  onFailure: (cause) => Queue.failCause(queue, cause),
                  onSuccess: () =>
                    refreshGitStatus(input.cwd).pipe(
                      Effect.andThen(Queue.end(queue).pipe(Effect.asVoid)),
                    ),
                }),
              ),
            ),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.gitResolvePullRequest]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitResolvePullRequest,
            gitWorkflow.resolvePullRequest(input),
            {
              "rpc.aggregate": "git",
            },
          ),
        [WS_METHODS.gitPreparePullRequestThread]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitPreparePullRequestThread,
            requireChatWorkspaceWritable(input.cwd).pipe(
              Effect.andThen(gitWorkflow.preparePullRequestThread(input)),
              Effect.tap(() => refreshGitStatus(input.cwd)),
            ),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.vcsListRefs]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsListRefs,
            isAxisChatCwd(config.stateDir, input.cwd)
              ? Effect.succeed({
                  refs: [],
                  isRepo: false,
                  hasPrimaryRemote: false,
                  nextCursor: null,
                  totalCount: 0,
                })
              : gitWorkflow.listRefs(input),
            {
              "rpc.aggregate": "vcs",
            },
          ),
        [WS_METHODS.vcsCreateWorktree]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsCreateWorktree,
            requireChatWorkspaceWritable(input.cwd).pipe(
              Effect.andThen(gitWorkflow.createWorktree(input)),
              Effect.tap(() => refreshGitStatus(input.cwd)),
            ),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsRemoveWorktree]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsRemoveWorktree,
            requireChatWorkspaceWritable(input.cwd).pipe(
              Effect.andThen(gitWorkflow.removeWorktree(input)),
              Effect.tap(() => refreshGitStatus(input.cwd)),
            ),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsCreateRef]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsCreateRef,
            requireChatWorkspaceWritable(input.cwd).pipe(
              Effect.andThen(gitWorkflow.createRef(input)),
              Effect.tap(() => refreshGitStatus(input.cwd)),
            ),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsSwitchRef]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsSwitchRef,
            requireChatWorkspaceWritable(input.cwd).pipe(
              Effect.andThen(gitWorkflow.switchRef(input)),
              Effect.tap(() => refreshGitStatus(input.cwd)),
            ),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsInit]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsInit,
            (isAxisChatCwd(config.stateDir, input.cwd)
              ? Effect.fail(
                  new VcsUnsupportedOperationError({
                    operation: "init",
                    kind: input.kind ?? "git",
                    detail: "Chats does not support repositories.",
                  }),
                )
              : vcsProvisioning.initRepository(input)
            ).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.reviewGetDiffPreview]: (input) =>
          observeRpcEffect(WS_METHODS.reviewGetDiffPreview, review.getDiffPreview(input), {
            "rpc.aggregate": "review",
          }),
        [WS_METHODS.reviewGetDiffFileContents]: (input) =>
          observeRpcEffect(
            WS_METHODS.reviewGetDiffFileContents,
            review.getDiffFileContents(input),
            { "rpc.aggregate": "review" },
          ),
        [WS_METHODS.terminalOpen]: (input) =>
          observeRpcEffect(
            WS_METHODS.terminalOpen,
            requireChatTerminalAvailable(input).pipe(Effect.andThen(terminalManager.open(input))),
            {
              "rpc.aggregate": "terminal",
            },
          ),
        [WS_METHODS.terminalAttach]: (input) =>
          observeRpcStream(
            WS_METHODS.terminalAttach,
            Stream.callback<TerminalAttachStreamEvent, TerminalError>((queue) =>
              Effect.acquireRelease(
                requireChatTerminalAvailable(input).pipe(
                  Effect.andThen(
                    terminalManager.attachStream(input, (event) => Queue.offer(queue, event)),
                  ),
                ),
                (unsubscribe) => Effect.sync(unsubscribe),
              ),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.terminalWrite]: (input) =>
          observeRpcEffect(
            WS_METHODS.terminalWrite,
            requireChatTerminalAvailable(input).pipe(Effect.andThen(terminalManager.write(input))),
            {
              "rpc.aggregate": "terminal",
            },
          ),
        [WS_METHODS.terminalResize]: (input) =>
          observeRpcEffect(WS_METHODS.terminalResize, terminalManager.resize(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalClear]: (input) =>
          observeRpcEffect(WS_METHODS.terminalClear, terminalManager.clear(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalRestart]: (input) =>
          observeRpcEffect(
            WS_METHODS.terminalRestart,
            requireChatTerminalAvailable(input).pipe(
              Effect.andThen(terminalManager.restart(input)),
            ),
            {
              "rpc.aggregate": "terminal",
            },
          ),
        [WS_METHODS.terminalClose]: (input) =>
          observeRpcEffect(WS_METHODS.terminalClose, terminalManager.close(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.subscribeTerminalEvents]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeTerminalEvents,
            Stream.callback<TerminalEvent>((queue) =>
              Effect.acquireRelease(
                terminalManager.subscribe((event) => Queue.offer(queue, event)),
                (unsubscribe) => Effect.sync(unsubscribe),
              ),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.subscribeTerminalMetadata]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeTerminalMetadata,
            Stream.callback<TerminalMetadataStreamEvent>((queue) =>
              Effect.acquireRelease(
                terminalManager.subscribeMetadata((event) => Queue.offer(queue, event)),
                (unsubscribe) => Effect.sync(unsubscribe),
              ),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.previewOpen]: (input) =>
          observeRpcEffect(WS_METHODS.previewOpen, previewManager.open(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewNavigate]: (input) =>
          observeRpcEffect(WS_METHODS.previewNavigate, previewManager.navigate(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewResize]: (input) =>
          observeRpcEffect(WS_METHODS.previewResize, previewManager.resize(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewRefresh]: (input) =>
          observeRpcEffect(WS_METHODS.previewRefresh, previewManager.refresh(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewClose]: (input) =>
          observeRpcEffect(WS_METHODS.previewClose, previewManager.close(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewList]: (input) =>
          observeRpcEffect(WS_METHODS.previewList, previewManager.list(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewReportStatus]: (input) =>
          observeRpcEffect(WS_METHODS.previewReportStatus, previewManager.reportStatus(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewAutomationConnect]: (input) =>
          observeRpcStreamEffect(
            WS_METHODS.previewAutomationConnect,
            previewAutomationBroker.connect(input),
            { "rpc.aggregate": "preview-automation" },
          ),
        [WS_METHODS.previewAutomationRespond]: (input) =>
          observeRpcEffect(
            WS_METHODS.previewAutomationRespond,
            previewAutomationBroker.respond(input),
            { "rpc.aggregate": "preview-automation" },
          ),
        [WS_METHODS.previewAutomationFocusHost]: (input) =>
          observeRpcEffect(
            WS_METHODS.previewAutomationFocusHost,
            previewAutomationBroker.focusHost(input),
            { "rpc.aggregate": "preview-automation" },
          ),
        [WS_METHODS.subscribePreviewEvents]: (_input) =>
          observeRpcStream(WS_METHODS.subscribePreviewEvents, previewManager.events, {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.subscribeDiscoveredLocalServers]: (input) =>
          observeRpcStream(
            WS_METHODS.subscribeDiscoveredLocalServers,
            Stream.callback<DiscoveredLocalServerList>((queue) =>
              Effect.gen(function* () {
                const configuredUrls = input.configuredUrls ?? [];
                yield* portDiscovery.retain;
                const initial = yield* portDiscovery.scan(configuredUrls);
                const initialScannedAt = DateTime.formatIso(yield* DateTime.now);
                yield* Queue.offer(queue, {
                  servers: initial,
                  scannedAt: initialScannedAt,
                  configuredUrlProbing: true,
                });
                yield* portDiscovery.subscribe(
                  { configuredUrls, initialSnapshot: initial },
                  (servers) =>
                    Effect.gen(function* () {
                      const scannedAt = DateTime.formatIso(yield* DateTime.now);
                      yield* Queue.offer(queue, {
                        servers,
                        scannedAt,
                        configuredUrlProbing: true,
                      });
                    }),
                );
              }),
            ),
            { "rpc.aggregate": "preview" },
          ),
        [WS_METHODS.subscribeServerConfig]: (input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeServerConfig,
            Effect.gen(function* () {
              const keybindingsUpdates = keybindings.streamChanges.pipe(
                Stream.map((event) => ({
                  version: 1 as const,
                  type: "keybindingsUpdated" as const,
                  payload: {
                    keybindings: event.keybindings,
                    issues: event.issues,
                  },
                })),
              );
              const providerStatuses = providerRegistry.streamChanges.pipe(
                Stream.map((providers) => ({
                  version: 1 as const,
                  type: "providerStatuses" as const,
                  payload: { providers },
                })),
                Stream.debounce(Duration.millis(PROVIDER_STATUS_DEBOUNCE_MS)),
              );
              // The only source of published themes: the stream emits the
              // current set before any change, so the snapshot carrying it too
              // would just send every client the same array twice per connect.
              // Gated on the subscriber's capability flag because an
              // already-shipped client decodes this stream against the old
              // event union and its whole config subscription dies on an
              // unknown member.
              const environmentThemeUpdates =
                input.environmentThemes === true
                  ? environmentTheme.streamChanges.pipe(
                      Stream.map((themes) => ({
                        version: 1 as const,
                        type: "environmentThemesUpdated" as const,
                        payload: { themes },
                      })),
                    )
                  : Stream.empty;
              // Same gate as themes: an older client dies on an unknown event.
              const usageLimitSourceUpdates =
                input.usageLimitSources === true
                  ? usageLimitSources.streamChanges.pipe(
                      Stream.map((sources) => ({
                        version: 1 as const,
                        type: "usageLimitSourcesUpdated" as const,
                        payload: { sources },
                      })),
                    )
                  : Stream.empty;
              const settingsUpdates = serverSettings.streamChanges.pipe(
                Stream.map((settings) => ServerSettings.redactServerSettingsForClient(settings)),
                Stream.map((settings) => ({
                  version: 1 as const,
                  type: "settingsUpdated" as const,
                  payload: { settings },
                })),
              );

              yield* providerRegistry
                .refresh()
                .pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);

              const liveUpdates = Stream.merge(
                keybindingsUpdates,
                Stream.merge(
                  providerStatuses,
                  Stream.merge(
                    settingsUpdates,
                    Stream.merge(environmentThemeUpdates, usageLimitSourceUpdates),
                  ),
                ),
              );

              return Stream.concat(
                Stream.make({
                  version: 1 as const,
                  type: "snapshot" as const,
                  config: yield* loadServerConfig,
                }),
                liveUpdates,
              );
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeServerLifecycle]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeServerLifecycle,
            Effect.gen(function* () {
              const snapshot = yield* lifecycleEvents.snapshot;
              const snapshotEvents = Array.from(snapshot.events).toSorted(
                (left, right) => left.sequence - right.sequence,
              );
              const liveEvents = lifecycleEvents.stream.pipe(
                Stream.filter((event) => event.sequence > snapshot.sequence),
              );
              return Stream.concat(Stream.fromIterable(snapshotEvents), liveEvents);
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeAuthAccess]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeAuthAccess,
            Effect.gen(function* () {
              const initialSnapshot = yield* loadAuthAccessSnapshot();
              const revisionRef = yield* Ref.make(1);
              const accessChanges: Stream.Stream<
                PairingGrantStore.BootstrapCredentialChange | SessionStore.SessionCredentialChange
              > = Stream.merge(bootstrapCredentials.streamChanges, sessions.streamChanges);

              const liveEvents: Stream.Stream<AuthAccessStreamEvent> = accessChanges.pipe(
                Stream.mapEffect((change) =>
                  Ref.updateAndGet(revisionRef, (revision) => revision + 1).pipe(
                    Effect.map((revision) =>
                      toAuthAccessStreamEvent(change, revision, currentSessionId),
                    ),
                  ),
                ),
              );

              return Stream.concat(
                Stream.make({
                  version: 1 as const,
                  revision: 1,
                  type: "snapshot" as const,
                  payload: initialSnapshot,
                }),
                liveEvents,
              );
            }),
            { "rpc.aggregate": "auth" },
          ),
        [WS_METHODS.subscribeBackgroundPolicy]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeBackgroundPolicy,
            Stream.unwrap(
              Effect.map(backgroundPolicy.subscribe, ({ latest, changes }) =>
                Stream.concat(Stream.make(latest), changes),
              ),
            ),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeResourceTelemetry]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeResourceTelemetry,
            Stream.unwrap(
              Effect.map(resourceTelemetry.subscribe, ({ latest, changes }) =>
                Stream.concat(Stream.make(latest), changes),
              ),
            ),
            { "rpc.aggregate": "server" },
          ),
      });
    }),
  );

export const websocketRpcRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const previewAutomationBroker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const baseServerSelfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
    const config = yield* ServerConfig.ServerConfig;
    const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
    const serverSelfUpdate = yield* ServerSelfUpdate.withRunningThreadContinuation({
      mode: config.mode,
      selfUpdate: baseServerSelfUpdate,
      prepare: startup.markRunningProviderSessionsForContinuation.pipe(
        Effect.mapError(
          (cause) =>
            new ServerSelfUpdateError({
              reason: "Could not prepare running threads to continue after the update.",
              cause,
            }),
        ),
      ),
      clear: (threadIds) =>
        startup.clearProviderSessionContinuationMarkers(threadIds).pipe(
          Effect.mapError(
            (cause) =>
              new ServerSelfUpdateError({
                reason: "Could not clear thread continuation markers after the update failed.",
                cause,
              }),
          ),
        ),
    });
    const pullRequests = yield* PullRequestService.PullRequestService;
    return HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        const analytics = yield* AnalyticsService.AnalyticsService;
        const session = yield* serverAuth.authenticateWebSocketUpgrade(request).pipe(
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(
              EnvironmentAuth.serverAuthCredentialReason(error),
              EnvironmentAuth.serverAuthDpopFailureReason(error),
            ),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("internal_error", error),
          ),
        );
        const clientOrigin = readClientConnectionOrigin(request);
        const clientAnalyticsProps = readClientAnalyticsProps(request);
        yield* sessions.recordClientConnection(session.sessionId, clientOrigin);
        yield* analytics.record("client.connected", clientAnalyticsProps);
        const rpcWebSocketHttpEffect = yield* RpcServer.toHttpEffectWebsocket(WsRpcGroup, {
          disableTracing: true,
        }).pipe(
          Effect.provide(
            makeWsRpcLayer(
              session,
              clientOrigin,
              clientAnalyticsProps,
              previewAutomationBroker,
            ).pipe(
              Layer.provideMerge(RpcSerialization.layerJson),
              Layer.provide(ProviderMaintenanceRunner.layer),
              Layer.provide(Layer.succeed(ServerSelfUpdate.ServerSelfUpdate, serverSelfUpdate)),
              // One server-lifetime service means clients share the same PR caches, and a WS
              // mutation invalidates the HTTP diff cache that every client reads from.
              Layer.provide(Layer.succeed(PullRequestService.PullRequestService, pullRequests)),
              Layer.provide(
                SourceControlDiscovery.layer.pipe(
                  Layer.provide(
                    SourceControlProviderRegistry.layer.pipe(
                      Layer.provide(
                        Layer.mergeAll(
                          AzureDevOpsCli.layer,
                          BitbucketApi.layer,
                          GitHubCli.layer,
                          GitLabCli.layer,
                        ),
                      ),
                      Layer.provideMerge(GitVcsDriver.layer),
                      Layer.provide(
                        VcsDriverRegistry.layer.pipe(Layer.provide(VcsProjectConfig.layer)),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
        return yield* Effect.acquireUseRelease(
          sessions.markConnected(session.sessionId),
          () => rpcWebSocketHttpEffect,
          () => sessions.markDisconnected(session.sessionId),
        );
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
        }),
      ),
    );
  }),
);
