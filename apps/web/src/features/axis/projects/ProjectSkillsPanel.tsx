import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";
import { DownloadIcon, PencilIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { ensureLocalApi } from "~/localApi";
import { toastManager } from "~/components/ui/toast";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  AXIS_AGENTS_PATH,
  mergeAxisAgentsBlock,
  PROJECT_SKILL_ROOT,
  SKILL_NAME_PATTERN,
  missingStarterSkills,
  collectProjectSkills,
  projectSkillPath,
  skillBody,
  skillDocument,
  type ProjectSkill,
  type SkillDraft,
} from "./ProjectSkillsPanel.logic";

const EMPTY_DRAFT: SkillDraft = { name: "", description: "", instructions: "" };

export function ProjectSkillsPanel({
  environmentId,
  workspaceRoot,
  providers,
}: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly providers: ReadonlyArray<ServerProvider>;
}) {
  const writeFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });
  const deleteFile = useAtomCommand(projectEnvironment.deleteFile, { reportFailure: false });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<ProjectSkill | null>(null);
  const [draft, setDraft] = useState<SkillDraft>(EMPTY_DRAFT);
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [agentsBridgeReady, setAgentsBridgeReady] = useState(false);

  useEffect(() => {
    setAgentsBridgeReady(false);
  }, [environmentId, workspaceRoot]);

  const projectEntriesQuery = useEnvironmentQuery(
    projectEnvironment.listEntries({ environmentId, input: { cwd: workspaceRoot } }),
  );
  const agentsFileQuery = useEnvironmentQuery(
    projectEnvironment.readFile({
      environmentId,
      input: { cwd: workspaceRoot, relativePath: AXIS_AGENTS_PATH },
    }),
  );

  const skills = useMemo(
    () => collectProjectSkills(providers, workspaceRoot),
    [providers, workspaceRoot],
  );
  const starterSkills = useMemo(() => missingStarterSkills(skills), [skills]);

  const skillFileQuery = useEnvironmentQuery(
    editingSkill === null
      ? null
      : projectEnvironment.readFile({
          environmentId,
          input: { cwd: workspaceRoot, relativePath: editingSkill.relativePath },
        }),
  );

  useEffect(() => {
    const file = skillFileQuery.data;
    if (editingSkill === null || file === null || loadedPath === editingSkill.relativePath) {
      return;
    }
    setDraft((current) => ({ ...current, instructions: skillBody(file.contents) }));
    setLoadedPath(editingSkill.relativePath);
  }, [editingSkill, loadedPath, skillFileQuery.data]);

  const openCreate = () => {
    setEditingSkill(null);
    setDraft(EMPTY_DRAFT);
    setLoadedPath(null);
    setDialogOpen(true);
  };

  const openEdit = (skill: ProjectSkill) => {
    setEditingSkill(skill);
    setDraft({ name: skill.name, description: skill.description, instructions: "" });
    setLoadedPath(null);
    setDialogOpen(true);
  };

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    await Promise.all(
      providers.map((provider) =>
        refreshProviders({
          environmentId,
          input: {
            instanceId: provider.instanceId,
            cwd: workspaceRoot,
            projectRoot: workspaceRoot,
            forceWorkspaceRefresh: true,
          },
        }),
      ),
    );
    setRefreshing(false);
  };

  const ensureAgentsBridge = async (): Promise<boolean> => {
    if (projectEntriesQuery.isPending || agentsFileQuery.isPending) return false;
    if (agentsBridgeReady) return true;
    if (projectEntriesQuery.error !== null) {
      toastManager.add({
        type: "error",
        title: "Could not inspect AGENTS.md",
        description:
          "The project file index could not be read, so existing instructions were left untouched.",
      });
      return false;
    }
    const agentsEntry = projectEntriesQuery.data?.entries.some(
      (entry) => entry.kind === "file" && entry.path === AXIS_AGENTS_PATH,
    );
    if (agentsEntry && agentsFileQuery.data === null) {
      toastManager.add({
        type: "error",
        title: "Could not safely update AGENTS.md",
        description: "The existing AGENTS.md could not be read, so it was left untouched.",
      });
      return false;
    }
    const existingContents = agentsFileQuery.data?.contents ?? "";
    const mergedContents = mergeAxisAgentsBlock(existingContents);
    if (mergedContents === existingContents) {
      setAgentsBridgeReady(true);
      return true;
    }
    const result = await writeFile({
      environmentId,
      input: {
        cwd: workspaceRoot,
        relativePath: AXIS_AGENTS_PATH,
        contents: mergedContents,
      },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Could not update AGENTS.md",
          description:
            error instanceof Error ? error.message : "The Axis skill bridge could not be written.",
        });
      }
      return false;
    }
    setAgentsBridgeReady(true);
    return true;
  };

  const remove = async (skill: ProjectSkill) => {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Delete “${skill.displayName}” from this project? This removes only the Axis-managed skill, not provider-native or personal skills.`,
      { variant: "destructive" },
    );
    if (!confirmed || saving) return;

    setSaving(true);
    const paths = [...new Set(skill.relativePaths)];
    const results = await Promise.all(
      paths.map((relativePath) =>
        deleteFile({ environmentId, input: { cwd: workspaceRoot, relativePath } }),
      ),
    );
    setSaving(false);
    const failure = results.find((result) => result._tag === "Failure");
    if (failure) {
      if (!isAtomCommandInterrupted(failure)) {
        const error = squashAtomCommandFailure(failure);
        toastManager.add({
          type: "error",
          title: "Could not delete skill",
          description:
            error instanceof Error ? error.message : "The project files could not be updated.",
        });
      }
      return;
    }
    if (editingSkill?.name === skill.name) {
      setDialogOpen(false);
      setEditingSkill(null);
    }
    toastManager.add({ type: "success", title: "Skill deleted" });
    await refresh();
  };

  const save = async () => {
    const normalizedName = draft.name.trim().toLowerCase();
    const description = draft.description.trim();
    const instructions = draft.instructions.trim();
    if (!SKILL_NAME_PATTERN.test(normalizedName)) {
      toastManager.add({
        type: "error",
        title: "Invalid skill name",
        description: "Use lowercase letters, numbers, hyphens, or underscores.",
      });
      return;
    }
    if (!description || !instructions) {
      toastManager.add({
        type: "error",
        title: "Complete the skill",
        description: "A description and instructions are required.",
      });
      return;
    }
    if (
      skills.some(
        (skill) =>
          skill.name.toLowerCase() === normalizedName &&
          skill.name.toLowerCase() !== editingSkill?.name.toLowerCase(),
      )
    ) {
      toastManager.add({ type: "error", title: "Skill already exists" });
      return;
    }

    setSaving(true);
    const contents = skillDocument({ name: normalizedName, description, instructions });
    if (!(await ensureAgentsBridge())) {
      setSaving(false);
      return;
    }
    const writeResults = [
      await writeFile({
        environmentId,
        input: {
          cwd: workspaceRoot,
          relativePath: projectSkillPath(normalizedName),
          contents,
        },
      }),
    ];
    const writeFailure = writeResults.find((result) => result._tag === "Failure");
    if (writeFailure) {
      setSaving(false);
      if (!isAtomCommandInterrupted(writeFailure)) {
        const error = squashAtomCommandFailure(writeFailure);
        toastManager.add({
          type: "error",
          title: "Could not save skill",
          description:
            error instanceof Error ? error.message : "The project files could not be updated.",
        });
      }
      return;
    }

    if (editingSkill !== null && editingSkill.name.toLowerCase() !== normalizedName) {
      const oldPaths = [...new Set(editingSkill.relativePaths)];
      const deleteResults = await Promise.all(
        oldPaths.map((relativePath) =>
          deleteFile({ environmentId, input: { cwd: workspaceRoot, relativePath } }),
        ),
      );
      const deleteFailure = deleteResults.find((result) => result._tag === "Failure");
      if (deleteFailure) {
        setSaving(false);
        if (!isAtomCommandInterrupted(deleteFailure)) {
          const error = squashAtomCommandFailure(deleteFailure);
          toastManager.add({
            type: "error",
            title: "Skill saved but old name remains",
            description:
              error instanceof Error
                ? error.message
                : "The new skill was saved, but the old files could not be removed.",
          });
        }
        await refresh();
        return;
      }
    }

    setSaving(false);
    setDialogOpen(false);
    toastManager.add({
      type: "success",
      title: editingSkill === null ? "Skill created" : "Skill updated",
      description: "Refreshing provider skill catalogs.",
    });
    await refresh();
  };

  const installStarterSkills = async () => {
    if (saving || starterSkills.length === 0) return;
    setSaving(true);
    if (!(await ensureAgentsBridge())) {
      setSaving(false);
      return;
    }
    const results = await Promise.all(
      starterSkills.map((skill) =>
        writeFile({
          environmentId,
          input: {
            cwd: workspaceRoot,
            relativePath: projectSkillPath(skill.name),
            contents: skillDocument(skill),
          },
        }),
      ),
    );
    setSaving(false);
    const failure = results.find((result) => result._tag === "Failure");
    if (failure) {
      if (!isAtomCommandInterrupted(failure)) {
        const error = squashAtomCommandFailure(failure);
        toastManager.add({
          type: "error",
          title: "Could not install starter skills",
          description:
            error instanceof Error ? error.message : "The project files could not be updated.",
        });
      }
      return;
    }
    toastManager.add({
      type: "success",
      title: "Starter skills installed",
      description: "They are now available in the composer for every provider.",
    });
    await refresh();
  };

  return (
    <>
      <SettingsSection
        title="Project skills"
        description={`Skills live once in ${PROJECT_SKILL_ROOT} and are available in the composer for every provider.`}
        headerAction={
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="icon-sm"
              variant="ghost-muted"
              aria-label="Refresh project skills"
              title="Refresh project skills"
              disabled={refreshing}
              onClick={() => void refresh()}
            >
              <RefreshCwIcon className={refreshing ? "animate-spin" : undefined} />
            </Button>
            <Button type="button" size="xs" onClick={openCreate}>
              <PlusIcon />
              Create skill
            </Button>
          </div>
        }
      >
        {skills.length === 0 ? (
          <SettingsRow
            title="No project skills yet"
            description="Create one once and use it from the composer with $."
            control={
              <Button type="button" size="xs" variant="outline" onClick={openCreate}>
                <PlusIcon />
                Create skill
              </Button>
            }
          />
        ) : (
          skills.map((skill) => (
            <SettingsRow
              key={skill.name}
              title={skill.displayName}
              description={skill.description || skill.relativePath}
              status={<Badge variant="success">{skill.providers.join(", ")}</Badge>}
              control={
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost-muted"
                    disabled={saving}
                    onClick={() => openEdit(skill)}
                  >
                    <PencilIcon />
                    Edit
                  </Button>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost-muted"
                    disabled={saving}
                    aria-label={`Delete ${skill.displayName}`}
                    title="Delete skill"
                    onClick={() => void remove(skill)}
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              }
            />
          ))
        )}
      </SettingsSection>

      {starterSkills.length > 0 ? (
        <SettingsSection
          title="Starter skills"
          description="Ready-made workflows for everyday engineering work. Install the missing ones once; existing project skills are left untouched."
          headerAction={
            <Button
              type="button"
              size="xs"
              disabled={saving}
              onClick={() => void installStarterSkills()}
            >
              <DownloadIcon />
              {saving ? "Installing..." : "Install starter kit"}
            </Button>
          }
        >
          {starterSkills.map((skill) => (
            <SettingsRow
              key={skill.name}
              title={skill.name}
              description={skill.description}
              status={<Badge variant="outline">Ready to add</Badge>}
            />
          ))}
        </SettingsSection>
      ) : null}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogPopup className="w-full sm:w-[36rem]">
          <DialogHeader>
            <DialogTitle>
              {editingSkill === null ? "Create project skill" : "Edit project skill"}
            </DialogTitle>
            <DialogDescription>
              Write the behavior once. Axis stores it in {PROJECT_SKILL_ROOT} and exposes it to
              every provider.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="grid gap-4">
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Name</span>
              <Input
                value={draft.name}
                disabled={editingSkill !== null}
                placeholder="review-follow-up"
                onChange={(event) =>
                  setDraft((current) => ({ ...current, name: event.target.value }))
                }
              />
            </label>
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Description</span>
              <Input
                value={draft.description}
                placeholder="Review requested changes and verify the fix"
                onChange={(event) =>
                  setDraft((current) => ({ ...current, description: event.target.value }))
                }
              />
            </label>
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Instructions</span>
              <Textarea
                value={draft.instructions}
                placeholder={
                  skillFileQuery.isPending
                    ? "Loading skill..."
                    : "Inspect the feedback, make the smallest correction, and run the relevant checks."
                }
                disabled={editingSkill !== null && skillFileQuery.isPending}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, instructions: event.target.value }))
                }
              />
              {skillFileQuery.error ? (
                <span className="text-xs text-destructive">Could not load the existing skill.</span>
              ) : null}
            </label>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={saving || (editingSkill !== null && skillFileQuery.isPending)}
              onClick={() => void save()}
            >
              {saving ? "Saving..." : editingSkill === null ? "Create skill" : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
