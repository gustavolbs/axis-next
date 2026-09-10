import { useMemo, useState } from "react";
import {
  ThreadId,
  type AxisContextProjectScope,
  type EnvironmentConnectionState,
  type ModelSelection,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useThreadShellsForProjectRefs } from "~/state/entities";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { ProjectWorkflowPanel } from "./ProjectWorkflowPanel";
import { Button } from "~/components/ui/button";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { randomUUID } from "~/lib/utils";

export function ProjectWorkflowView({
  scope,
  connectionState,
  defaultModelSelection,
}: {
  readonly scope: AxisContextProjectScope;
  readonly connectionState: EnvironmentConnectionState | "unauthorized";
  readonly defaultModelSelection: ModelSelection | null;
}) {
  const refs = useMemo(() => [scope.project], [scope.project]);
  const shells = useThreadShellsForProjectRefs(refs);
  const threads = shells.filter(
    (thread) =>
      thread.archivedAt === null &&
      !thread.id.startsWith("axis-workflow-") &&
      !thread.id.startsWith("axis-execution-") &&
      !thread.id.startsWith("onboarding-"),
  );
  const [chosen, setChosen] = useState<ThreadId | null>(null);
  const thread = threads.find((candidate) => candidate.id === chosen) ?? null;
  const modelSelection = thread?.modelSelection ?? defaultModelSelection;
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createConversation = async () => {
    if (creating || defaultModelSelection === null || connectionState !== "connected") return;
    setCreating(true);
    setError(null);
    try {
      const threadId = ThreadId.make(randomUUID());
      const result = await createThread({
        environmentId: scope.project.environmentId,
        input: {
          threadId,
          projectId: scope.project.projectId,
          title: "WorkHub task",
          modelSelection: defaultModelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: new Date().toISOString(),
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      setChosen(threadId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the task conversation.");
    } finally {
      setCreating(false);
    }
  };
  return (
    <>
      <SettingsSection
        title="Task conversation"
        description="Select a project conversation or create one for this task. Execution uses the selected physical workspace."
        headerAction={
          <Button
            size="xs"
            disabled={creating || defaultModelSelection === null || connectionState !== "connected"}
            onClick={() => void createConversation()}
          >
            New task conversation
          </Button>
        }
      >
        <SettingsRow
          title="Conversation"
          control={
            <select
              aria-label="Workflow conversation"
              className="max-w-80 rounded-md border bg-background px-2 py-1 text-sm"
              value={thread?.id ?? ""}
              onChange={(event) =>
                setChosen(
                  threads.find((candidate) => candidate.id === event.target.value)?.id ?? null,
                )
              }
              disabled={connectionState !== "connected"}
            >
              <option value="">Select a conversation</option>
              {threads.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.title}
                </option>
              ))}
            </select>
          }
        />
        <SettingsRow
          title="Provider and model"
          description={
            modelSelection === null
              ? "No provider model is available."
              : `${modelSelection.instanceId} · ${modelSelection.model}`
          }
        />
        {error === null ? null : (
          <SettingsRow title="Could not create conversation" description={error} />
        )}
      </SettingsSection>
      <ProjectWorkflowPanel
        key={thread?.id ?? "none"}
        environmentId={scope.project.environmentId}
        scope={scope}
        threadId={thread?.id ?? null}
        modelSelection={modelSelection}
        connectionState={connectionState}
      />
    </>
  );
}
