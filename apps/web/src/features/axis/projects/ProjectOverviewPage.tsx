import {
  AxisContextId,
  axisProviderInstanceLocatorKey,
  resolveAxisContextProviderInstances,
  type AxisContextProjectScope,
  AxisOnboardingCandidateRuleId,
  AxisOnboardingDecisionId,
  CommandId,
  EnvironmentId,
  ProjectId,
  type AxisOnboardingRunSnapshot,
  type EnvironmentConnectionState,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { useCanGoBack, useNavigate } from "@tanstack/react-router";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  CheckCircle2Icon,
  CircleDashedIcon,
  ExternalLinkIcon,
  SettingsIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { SidebarInset } from "~/components/ui/sidebar";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { SettingsSection, SettingsRow } from "~/components/settings/settingsLayout";
import { WorkspacePageContainer } from "~/components/WorkspacePageContainer";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { useEnvironments } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastManager } from "~/components/ui/toast";
import { randomUUID } from "~/lib/utils";
import { environmentCatalog } from "~/connection/catalog";
import { resolveDefaultProviderModelSelection } from "~/providerInstances";
import { useSettingsProjectGroups } from "~/components/settings/ProjectSettingsPanel";
import { ProjectOnboardingPanel } from "./ProjectOnboardingPanel";
import { ProjectPatternsPanel } from "./ProjectPatternsPanel";
import { ProjectContextPreviewPanel } from "./ProjectContextPreviewPanel";
import { ProjectWorkflowView } from "./ProjectWorkflowView";
import { ProjectIntegrationsPanel } from "./ProjectIntegrationsPanel";
import { ProjectLearningPanel } from "./ProjectLearningPanel";
import { ProjectSkillsPanel } from "./ProjectSkillsPanel";
import { setAxisProjectContext } from "../settings/AxisSettings.logic";
import type {
  ProjectOnboardingConnectionState,
  ProjectOnboardingProgress,
  ProjectOnboardingQuery,
  ProjectOnboardingRun,
} from "./projectOnboardingModel";
import {
  buildProjectOverviewModel,
  isAxisWorkflowAvailable,
  type AxisProjectOverviewMember,
} from "./projectOverviewModel";
import type { ProjectOverviewView } from "./projectOverviewRoute";

const connectionState = (phase: string): EnvironmentConnectionState => {
  switch (phase) {
    case "connected":
      return "connected";
    case "connecting":
    case "reconnecting":
      return "connecting";
    case "error":
      return "error";
    default:
      return "disconnected";
  }
};

function MemberState({ member }: { readonly member: AxisProjectOverviewMember }) {
  const Icon =
    member.connectionState === "connected"
      ? CheckCircle2Icon
      : member.connectionState === "error"
        ? AlertCircleIcon
        : CircleDashedIcon;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <Icon aria-hidden className="size-3.5" />
      {member.connectionState}
    </span>
  );
}

function viewTitle(view: ProjectOverviewView): string {
  switch (view) {
    case "patterns":
      return "Patterns";
    case "workflow":
      return "Workflow";
    case "integrations":
      return "Integrations";
    case "learning":
      return "Learning";
    default:
      return "Overview";
  }
}

const onboardingRunForUi = (snapshot: AxisOnboardingRunSnapshot): ProjectOnboardingRun => ({
  id: snapshot.run.id,
  scope: snapshot.run.scope,
  execution: snapshot.run.execution,
  status: snapshot.run.status,
  applied: snapshot.applied ?? false,
  sources: snapshot.run.sources.map((source) => ({
    path: source.path,
    status: source.status,
    error: source.error,
    ...(source.warning ? { warning: source.warning } : {}),
  })),
  candidateRules: snapshot.run.candidateRules.map((candidate) => ({
    id: candidate.id,
    category: candidate.category,
    text: candidate.text,
  })),
  conflicts: snapshot.run.conflicts,
  decisions: snapshot.run.decisions,
  error: snapshot.run.error,
});

const onboardingProgressForUi = (
  snapshot: AxisOnboardingRunSnapshot | null,
): ProjectOnboardingProgress | null => {
  if (snapshot === null) return null;
  const stage: ProjectOnboardingProgress["stage"] =
    snapshot.progress.stage === "collecting" ? "collecting" : "analyzing";
  return {
    stage,
    completed: snapshot.progress.completedSteps,
    total: snapshot.progress.totalSteps,
    label: snapshot.progress.message,
  };
};

export function ProjectOverviewPage({
  projectKey,
  view,
  selectedEnvironmentId,
  selectedProjectId,
}: {
  readonly projectKey: string;
  readonly view: Exclude<ProjectOverviewView, "settings">;
  readonly selectedEnvironmentId?: string;
  readonly selectedProjectId?: string;
}) {
  const navigate = useNavigate({ from: "/projects/$projectKey" });
  const rootNavigate = useNavigate();
  const canGoBack = useCanGoBack();
  const navigateBackWithinApp = useCallback(() => {
    if (canGoBack) {
      window.history.back();
      return;
    }
    void rootNavigate({ to: "/" });
  }, [canGoBack, rootNavigate]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key !== "Escape") return;
      event.preventDefault();
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement) activeElement.blur();
      navigateBackWithinApp();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigateBackWithinApp]);
  const groups = useSettingsProjectGroups();
  const environments = useEnvironments().environments;
  const group = groups.find((candidate) => candidate.projectKey === projectKey) ?? null;
  const selectedProjectRef = useMemo<ScopedProjectRef | null>(() => {
    if (selectedEnvironmentId && selectedProjectId) {
      return {
        environmentId: EnvironmentId.make(selectedEnvironmentId),
        projectId: ProjectId.make(selectedProjectId),
      };
    }
    return group === null ? null : { environmentId: group.environmentId, projectId: group.id };
  }, [group, selectedEnvironmentId, selectedProjectId]);
  const connectionStates = useMemo(
    () =>
      new Map(
        environments.map((environment) => [
          environment.environmentId,
          connectionState(environment.connection.phase),
        ]),
      ),
    [environments],
  );
  const selectedProject = useMemo(
    () =>
      group?.memberProjects.find(
        (project) =>
          project.environmentId === selectedProjectRef?.environmentId &&
          project.id === selectedProjectRef?.projectId,
      ) ?? null,
    [group, selectedProjectRef],
  );
  const selectedEnvironment = environments.find(
    (environment) => environment.environmentId === selectedProject?.environmentId,
  );
  const workflowAvailable = isAxisWorkflowAvailable(
    selectedEnvironment?.serverConfig?.environment.capabilities,
  );
  const catalogQuery = useEnvironmentQuery(
    selectedEnvironment?.serverConfig?.environment.capabilities.axis === true
      ? serverEnvironment.axisContextCatalog({
          environmentId: selectedEnvironment.environmentId,
          input: {},
        })
      : null,
  );
  const selectedContextId = useMemo<AxisContextId | null>(() => {
    if (selectedProject === null || catalogQuery.data === null) return null;
    const matchingContextIds = catalogQuery.data.catalog.projectBindings
      .filter(
        (binding) =>
          binding.project.environmentId === selectedProject.environmentId &&
          binding.project.projectId === selectedProject.id,
      )
      .map((binding) => binding.contextId);
    return matchingContextIds.length === 1 ? matchingContextIds[0]! : null;
  }, [catalogQuery.data, selectedProject]);
  const selectedProjectBindingContextIds = useMemo<ReadonlyArray<AxisContextId>>(
    () =>
      selectedProject === null || catalogQuery.data === null
        ? []
        : catalogQuery.data.catalog.projectBindings
            .filter(
              (binding) =>
                binding.project.environmentId === selectedProject.environmentId &&
                binding.project.projectId === selectedProject.id,
            )
            .map((binding) => binding.contextId),
    [catalogQuery.data, selectedProject],
  );
  const projectProviders = useMemo(() => {
    const providers = selectedEnvironment?.serverConfig?.providers ?? [];
    const environmentId = selectedEnvironment?.environmentId;
    if (catalogQuery.data === null || selectedContextId === null || environmentId === undefined) {
      return providers;
    }
    const accessible = new Set(
      resolveAxisContextProviderInstances(catalogQuery.data.catalog, selectedContextId).map(
        axisProviderInstanceLocatorKey,
      ),
    );
    return providers.filter((provider) =>
      accessible.has(
        axisProviderInstanceLocatorKey({
          environmentId,
          instanceId: provider.instanceId,
        }),
      ),
    );
  }, [catalogQuery.data, selectedContextId, selectedEnvironment]);
  const replaceCatalog = useAtomCommand(serverEnvironment.replaceAxisContextCatalog, {
    reportFailure: false,
  });
  const [savingProjectContext, setSavingProjectContext] = useState(false);
  const selectedScope = useMemo<AxisContextProjectScope | null>(
    () =>
      selectedProject === null || selectedContextId === null
        ? null
        : {
            contextId: selectedContextId,
            project: {
              environmentId: selectedProject.environmentId,
              projectId: selectedProject.id,
            },
          },
    [selectedContextId, selectedProject],
  );
  const model = useMemo(
    () =>
      group === null
        ? null
        : buildProjectOverviewModel({
            groups: [
              {
                key: group.projectKey,
                label: group.displayName,
                representative: group,
                members: group.memberProjects.map((project) => ({
                  physicalProjectKey: project.physicalProjectKey,
                  project,
                })),
                memberProjectRefs: group.memberProjectRefs,
              },
            ],
            selectedProjectRef,
            contextId: selectedContextId,
            bindings: catalogQuery.data?.catalog.projectBindings ?? [],
            connectionStates,
          }),
    [catalogQuery.data, connectionStates, group, selectedContextId, selectedProjectRef],
  );
  const profileQuery = useEnvironmentQuery(
    selectedScope === null || selectedProject === null
      ? null
      : serverEnvironment.axisProjectProfile({
          environmentId: selectedProject.environmentId,
          input: { scope: selectedScope },
        }),
  );
  const onboardingListQuery = useEnvironmentQuery(
    selectedScope === null || selectedProject === null
      ? null
      : serverEnvironment.axisOnboardingRuns({
          environmentId: selectedProject.environmentId,
          input: { scope: selectedScope },
        }),
  );
  const cancelOnboarding = useAtomCommand(serverEnvironment.cancelAxisOnboarding, {
    reportFailure: false,
  });
  const startOnboarding = useAtomCommand(serverEnvironment.startAxisOnboarding, {
    reportFailure: false,
  });
  const onboardingModelSelection = resolveDefaultProviderModelSelection(
    selectedEnvironment?.serverConfig?.providers ?? [],
    selectedProject?.defaultModelSelection ?? null,
  );
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const retryOnboarding = useAtomCommand(serverEnvironment.retryAxisOnboarding, {
    reportFailure: false,
  });
  const applyOnboarding = useAtomCommand(serverEnvironment.applyAxisOnboarding, {
    reportFailure: false,
  });
  const latestOnboarding = onboardingListQuery.data?.[0] ?? null;
  useEffect(() => {
    if (
      latestOnboarding?.run.status !== "running" ||
      selectedEnvironment?.connection.phase !== "connected" ||
      onboardingListQuery.error !== null
    )
      return;
    const timer = window.setInterval(onboardingListQuery.refresh, 2_000);
    return () => window.clearInterval(timer);
  }, [
    latestOnboarding?.run.status,
    selectedEnvironment?.connection.phase,
    onboardingListQuery.error,
    onboardingListQuery.refresh,
  ]);
  const onboardingQuery: ProjectOnboardingQuery = useMemo(
    () => ({
      data: latestOnboarding === null ? null : onboardingRunForUi(latestOnboarding),
      error: onboardingListQuery.error,
      isPending: onboardingListQuery.isPending,
      refresh: onboardingListQuery.refresh,
    }),
    [
      latestOnboarding,
      onboardingListQuery.error,
      onboardingListQuery.isPending,
      onboardingListQuery.refresh,
    ],
  );
  const onboardingConnectionState: ProjectOnboardingConnectionState =
    selectedProject === null
      ? "unauthorized"
      : (connectionStates.get(selectedProject.environmentId) ?? "disconnected");
  const learningConnectionState =
    onboardingConnectionState === "connected"
      ? "connected"
      : onboardingConnectionState === "connecting"
        ? "connecting"
        : onboardingConnectionState === "error"
          ? "error"
          : "disconnected";
  const onboardingCommands = useMemo(
    () => ({
      analyze: async () => {
        if (selectedScope === null || selectedProject === null || onboardingModelSelection === null)
          return;
        const result = await startOnboarding({
          environmentId: selectedProject.environmentId,
          input: {
            scope: selectedScope,
            commandId: CommandId.make(`axis-onboarding-${randomUUID()}`),
            modelSelection: onboardingModelSelection,
          },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      },
      cancel: async () => {
        if (selectedScope === null || selectedProject === null || latestOnboarding === null) return;
        const result = await cancelOnboarding({
          environmentId: selectedProject.environmentId,
          input: {
            scope: selectedScope,
            input: {
              runId: latestOnboarding.run.id,
              commandId: CommandId.make(`axis-onboarding-${randomUUID()}`),
              reason: "Cancelled from the project overview.",
            },
          },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      },
      retry: async () => {
        if (selectedScope === null || selectedProject === null || latestOnboarding === null) return;
        const result = await retryOnboarding({
          environmentId: selectedProject.environmentId,
          input: {
            scope: selectedScope,
            input: {
              runId: latestOnboarding.run.id,
              commandId: CommandId.make(`axis-onboarding-${randomUUID()}`),
            },
          },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      },
      reconnect: async () => {
        if (selectedProject === null) return;
        const result = await retryEnvironment(selectedProject.environmentId);
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        catalogQuery.refresh();
        onboardingListQuery.refresh();
        profileQuery.refresh();
      },
      apply: async (
        decisions: ReadonlyArray<{
          readonly id: string;
          readonly candidateRuleId: string;
          readonly decision: "accept" | "reject" | "defer";
          readonly note: string | null;
        }>,
      ) => {
        if (
          selectedScope === null ||
          selectedProject === null ||
          latestOnboarding === null ||
          profileQuery.data === null
        )
          return;
        const result = await applyOnboarding({
          environmentId: selectedProject.environmentId,
          input: {
            scope: selectedScope,
            runId: latestOnboarding.run.id,
            expectedProfileRevision: profileQuery.data.revision,
            decisions: decisions.map((decision) => ({
              id: AxisOnboardingDecisionId.make(decision.id),
              candidateRuleId: AxisOnboardingCandidateRuleId.make(decision.candidateRuleId),
              decision: decision.decision,
              note: decision.note,
            })),
            commandId: CommandId.make(`axis-onboarding-${randomUUID()}`),
          },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      },
    }),
    [
      applyOnboarding,
      cancelOnboarding,
      catalogQuery.refresh,
      latestOnboarding,
      onboardingListQuery.refresh,
      profileQuery.data,
      profileQuery.refresh,
      retryEnvironment,
      retryOnboarding,
      startOnboarding,
      onboardingModelSelection,
      selectedProject,
      selectedScope,
    ],
  );

  const selectMember = (member: AxisProjectOverviewMember) => {
    void navigate({
      search: {
        view,
        environmentId: member.project.environmentId,
        projectId: member.project.id,
      },
      replace: true,
    });
  };
  const setProjectContext = async (value: string | null) => {
    const snapshot = catalogQuery.data;
    if (
      snapshot === null ||
      selectedProject === null ||
      selectedEnvironment === undefined ||
      savingProjectContext
    ) {
      return;
    }
    setSavingProjectContext(true);
    const result = await replaceCatalog({
      environmentId: selectedEnvironment.environmentId,
      input: {
        expectedRevision: snapshot.revision,
        catalog: setAxisProjectContext(
          snapshot.catalog,
          {
            environmentId: selectedProject.environmentId,
            projectId: selectedProject.id,
          },
          value === null ? null : AxisContextId.make(value),
        ),
      },
    });
    setSavingProjectContext(false);
    if (result._tag === "Success") {
      catalogQuery.refresh();
      toastManager.add({ type: "success", title: "Project context updated" });
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not update project context",
        description: error instanceof Error ? error.message : "Refresh the project and try again.",
      });
    }
  };
  const openSettings = () => {
    void navigate({
      search: {
        view: "settings",
        ...(selectedProject
          ? { environmentId: selectedProject.environmentId, projectId: selectedProject.id }
          : {}),
      },
      replace: false,
    });
  };

  if (group === null || model === null) {
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground isolate">
        <WorkspacePageHeader>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Back to workspace"
            title="Back to workspace"
            onClick={navigateBackWithinApp}
          >
            <ArrowLeftIcon />
          </Button>
          <span className="text-sm font-medium">Project Overview</span>
        </WorkspacePageHeader>
        <WorkspacePageContainer>
          <SettingsSection title="Project unavailable">
            <SettingsRow
              title="No project selected"
              description="This project is no longer available in the connected environments."
            />
          </SettingsSection>
        </WorkspacePageContainer>
      </SidebarInset>
    );
  }

  const overviewGroup = model.groups[0]!;
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground isolate">
      <WorkspacePageHeader>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Back to workspace"
          title="Back to workspace"
          onClick={navigateBackWithinApp}
        >
          <ArrowLeftIcon />
        </Button>
        <div className="min-w-0 flex-1 truncate text-sm font-medium">{overviewGroup.label}</div>
        <Button size="xs" variant="outline" onClick={openSettings}>
          <SettingsIcon />
          Settings
        </Button>
      </WorkspacePageHeader>
      <div className="topbar-scroll-fade flex-1 overflow-y-auto">
        <WorkspacePageContainer width="wide" className="gap-7">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
                Project
              </p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight">{overviewGroup.label}</h1>
              <p className="mt-1 text-sm text-muted-foreground">{viewTitle(view)}</p>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <ExternalLinkIcon aria-hidden className="size-3.5" />
              {overviewGroup.bindingState === "bound"
                ? "Context binding ready"
                : overviewGroup.bindingState === "ambiguous"
                  ? "Context binding needs selection"
                  : "Context binding not configured"}
            </div>
          </div>

          <nav aria-label="Project views" className="flex flex-wrap gap-2">
            {(["overview", "patterns"] as const).map((target) => (
              <Button
                key={target}
                size="sm"
                variant={view === target ? "secondary" : "outline"}
                aria-current={view === target ? "page" : undefined}
                onClick={() =>
                  void navigate({
                    search: {
                      view: target,
                      ...(selectedProject
                        ? {
                            environmentId: selectedProject.environmentId,
                            projectId: selectedProject.id,
                          }
                        : {}),
                    },
                  })
                }
              >
                {viewTitle(target)}
              </Button>
            ))}
            <Button
              size="sm"
              variant={view === "learning" ? "secondary" : "ghost"}
              aria-current={view === "learning" ? "page" : undefined}
              onClick={() =>
                void navigate({
                  search: {
                    view: "learning",
                    ...(selectedProject
                      ? {
                          environmentId: selectedProject.environmentId,
                          projectId: selectedProject.id,
                        }
                      : {}),
                  },
                })
              }
            >
              Learning
            </Button>
            {(["workflow", "integrations"] as const).map((target) => (
              <Button
                key={target}
                size="sm"
                variant={view === target ? "secondary" : "ghost"}
                aria-current={view === target ? "page" : undefined}
                onClick={() =>
                  void navigate({
                    search: {
                      view: target,
                      ...(selectedProject
                        ? {
                            environmentId: selectedProject.environmentId,
                            projectId: selectedProject.id,
                          }
                        : {}),
                    },
                  })
                }
              >
                {viewTitle(target)}
              </Button>
            ))}
          </nav>

          {overviewGroup.members.length > 1 ? (
            <SettingsSection
              title="Physical members"
              description="Choose the environment that owns this project before running work."
            >
              {overviewGroup.members.map((member) => (
                <SettingsRow
                  key={member.physicalProjectKey}
                  title={`${member.project.title} · ${member.project.environmentId}`}
                  description={member.project.workspaceRoot}
                  status={<MemberState member={member} />}
                  control={
                    <Button
                      size="xs"
                      variant={member.isSelected ? "secondary" : "outline"}
                      onClick={() => selectMember(member)}
                    >
                      {member.isSelected ? "Selected" : "Select"}
                    </Button>
                  }
                />
              ))}
            </SettingsSection>
          ) : null}

          {selectedProject !== null &&
          selectedEnvironment?.serverConfig?.environment.capabilities.axis === true &&
          catalogQuery.data !== null ? (
            <SettingsSection
              title="Project context"
              description="Choose the context that determines this project's provider access and rules."
            >
              <SettingsRow
                title={
                  overviewGroup.bindingState === "ambiguous"
                    ? "Choose one context"
                    : selectedContextId === null
                      ? "No context assigned"
                      : (catalogQuery.data.catalog.contexts.find(
                          (context) => context.id === selectedContextId,
                        )?.name ?? "Context assigned")
                }
                description={selectedProject.workspaceRoot}
                control={
                  <Select
                    value={selectedProjectBindingContextIds.length === 1 ? selectedContextId : null}
                    disabled={savingProjectContext}
                    onValueChange={(value) => {
                      void setProjectContext(value === "unassigned" ? null : value);
                    }}
                  >
                    <SelectTrigger size="sm" className="w-48" aria-label="Project context">
                      <SelectValue placeholder="Choose context" />
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="unassigned">No context</SelectItem>
                      {catalogQuery.data.catalog.contexts.map((context) => (
                        <SelectItem key={context.id} value={context.id}>
                          {context.name}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                }
              />
              <SettingsRow
                title="Providers available in this context"
                description={
                  selectedContextId === null
                    ? "Assign a context to choose which provider accounts this project can use."
                    : projectProviders.length === 0
                      ? "No provider account is assigned to this context yet."
                      : projectProviders
                          .map((provider) => provider.displayName?.trim() || provider.driver)
                          .join(", ")
                }
                status={selectedContextId === null ? "Needs context" : projectProviders.length}
              />
            </SettingsSection>
          ) : selectedScope === null ? (
            <SettingsSection title="Project context">
              <SettingsRow
                title={
                  selectedEnvironment?.connection.phase !== "connected"
                    ? "Environment disconnected"
                    : selectedEnvironment.serverConfig?.environment.capabilities.axis !== true
                      ? "Axis requires a backend update"
                      : catalogQuery.isPending
                        ? "Loading project context"
                        : "Project context unavailable"
                }
                description={
                  selectedEnvironment?.connection.phase === "connected" &&
                  selectedEnvironment.serverConfig?.environment.capabilities.axis !== true
                    ? "Update the selected environment to use project onboarding and patterns."
                    : (catalogQuery.error ?? "Select a context to start working in this project.")
                }
                control={
                  selectedEnvironment?.serverConfig?.environment.capabilities.axis === true ? (
                    <Button size="xs" variant="outline" onClick={catalogQuery.refresh}>
                      Refresh
                    </Button>
                  ) : undefined
                }
              />
            </SettingsSection>
          ) : null}
          {view === "overview" &&
          selectedScope !== null &&
          (profileQuery.error !== null || profileQuery.isPending) ? (
            <SettingsSection title="Project profile">
              <SettingsRow
                title={
                  profileQuery.error ? "Could not load project profile" : "Loading project profile"
                }
                description={
                  profileQuery.error ??
                  "The profile must finish loading before decisions can be applied."
                }
                control={
                  <Button size="xs" variant="outline" onClick={profileQuery.refresh}>
                    Refresh profile
                  </Button>
                }
              />
            </SettingsSection>
          ) : null}
          {view === "overview" && selectedScope !== null && selectedProject !== null ? (
            <ProjectOnboardingPanel
              key={`${selectedScope.contextId}:${selectedProject.environmentId}:${selectedProject.id}`}
              scope={selectedScope}
              query={onboardingQuery}
              profileRevision={
                profileQuery.error === null && !profileQuery.isPending
                  ? (profileQuery.data?.revision ?? null)
                  : null
              }
              connectionState={onboardingConnectionState}
              analysisAvailable={onboardingModelSelection !== null}
              commands={onboardingCommands}
              projectLabel={overviewGroup.label}
              progress={onboardingProgressForUi(latestOnboarding)}
            />
          ) : null}
          {view === "overview" && selectedProject !== null ? (
            <ProjectSkillsPanel
              environmentId={selectedProject.environmentId}
              workspaceRoot={selectedProject.workspaceRoot}
              providers={projectProviders}
            />
          ) : null}
          {view === "patterns" && selectedScope !== null && selectedProject !== null ? (
            <>
              <ProjectContextPreviewPanel
                key={`preview:${selectedScope.contextId}:${selectedProject.environmentId}:${selectedProject.id}`}
                environmentId={selectedProject.environmentId}
                scope={selectedScope}
                modelSelection={onboardingModelSelection}
                connectionState={onboardingConnectionState}
              />
              <ProjectPatternsPanel
                key={`patterns:${selectedScope.contextId}:${selectedProject.environmentId}:${selectedProject.id}`}
                environmentId={selectedProject.environmentId}
                scope={selectedScope}
                connectionState={onboardingConnectionState}
                {...(overviewGroup.selectedMember?.physicalProjectKey === undefined
                  ? {}
                  : { physicalProjectKey: overviewGroup.selectedMember.physicalProjectKey })}
              />
            </>
          ) : null}
          {view === "learning" && selectedScope !== null && selectedProject !== null ? (
            <ProjectLearningPanel
              key={`${selectedScope.contextId}:${selectedProject.environmentId}:${selectedProject.id}`}
              environmentId={selectedProject.environmentId}
              scope={selectedScope}
              projectLabel={overviewGroup.label}
              connectionState={learningConnectionState}
            />
          ) : null}
          {view === "workflow" && selectedProject !== null && !workflowAvailable ? (
            <SettingsSection title="Workflow">
              <SettingsRow
                title="Workflow requires a backend update"
                description="Update the selected environment to use Work Hub workflows."
              />
            </SettingsSection>
          ) : null}
          {view === "workflow" &&
          workflowAvailable &&
          selectedScope !== null &&
          selectedProject !== null ? (
            <ProjectWorkflowView
              key={`${selectedScope.contextId}:${selectedProject.environmentId}:${selectedProject.id}`}
              scope={selectedScope}
              connectionState={onboardingConnectionState}
              defaultModelSelection={onboardingModelSelection}
            />
          ) : null}
          {view === "integrations" && selectedScope !== null && selectedProject !== null ? (
            <ProjectIntegrationsPanel
              key={`${selectedScope.contextId}:${selectedProject.environmentId}:${selectedProject.id}`}
              environmentId={selectedProject.environmentId}
              scope={selectedScope}
              projectKey={projectKey}
              projectLabel={overviewGroup.label}
              connectionState={onboardingConnectionState}
            />
          ) : null}
        </WorkspacePageContainer>
      </div>
    </SidebarInset>
  );
}
