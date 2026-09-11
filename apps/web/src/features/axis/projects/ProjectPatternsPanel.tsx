import { useMemo, useState } from "react";
import { AlertCircleIcon, CheckIcon, LockKeyholeIcon, RotateCcwIcon, SaveIcon } from "lucide-react";

import type { AxisContextProjectScope, AxisProjectRule, EnvironmentId } from "@t3tools/contracts";
import type { ProjectOnboardingConnectionState } from "./projectOnboardingModel";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import { SettingsSection } from "~/components/settings/settingsLayout";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  buildProjectPatternsModel,
  buildResetOverrideInput,
  buildRuleReplaceInput,
  type AxisProjectPatternEntry,
} from "./projectPatternsModel";

function originLabel(origin: AxisProjectRule["origin"]): string {
  switch (origin) {
    case "manual":
      return "Project override";
    case "inherited":
      return "Inherited";
    default:
      return origin[0]!.toUpperCase() + origin.slice(1);
  }
}

function errorMessage(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Refresh the project and try again.";
}

function sourceLabel(
  entry: AxisProjectPatternEntry,
  sources: ReadonlyArray<{ readonly id: string; readonly path: string }>,
): string {
  return (
    sources.find((source) => source.id === entry.sourceRule.sourceRef)?.path ??
    entry.sourceRule.sourceRef
  );
}

function PatternRow({
  entry,
  source,
  value,
  busy,
  onChange,
  onSave,
  onReset,
}: {
  readonly entry: AxisProjectPatternEntry;
  readonly source: string;
  readonly value: string;
  readonly busy: boolean;
  readonly onChange: (value: string) => void;
  readonly onSave: () => void;
  readonly onReset: () => void;
}) {
  const canSave = !entry.restrictionLocked && value.trim() !== entry.effectiveRule.text;
  return (
    <article className="space-y-3 border-b border-border/50 px-3 py-4 last:border-b-0 sm:px-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {entry.effectiveRule.id}
        </span>
        <Badge variant={entry.isOverridden ? "warning" : "outline"} size="sm">
          {entry.isOverridden ? "Override" : originLabel(entry.origin)}
        </Badge>
        {entry.isInherited ? (
          <Badge variant="secondary" size="sm">
            Inherited
          </Badge>
        ) : null}
        {entry.restrictionLocked ? (
          <Badge variant="info" size="sm">
            <LockKeyholeIcon aria-hidden />
            Locked
          </Badge>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
        <span>Source: {source}</span>
        {entry.invalidRestrictionOverride ? (
          <span className="inline-flex items-center gap-1 text-destructive">
            <AlertCircleIcon aria-hidden className="size-3.5" />
            Override is ignored until reset
          </span>
        ) : null}
      </div>
      <div className="flex items-start gap-2">
        <Textarea
          aria-label={`Pattern ${entry.effectiveRule.id}`}
          value={value}
          readOnly={entry.restrictionLocked}
          disabled={busy}
          onChange={(event) => onChange(event.target.value)}
          className="min-h-20 flex-1 resize-y"
        />
        <div className="flex shrink-0 items-center gap-1">
          {entry.isOverridden ? (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Reset override for ${entry.effectiveRule.id}`}
              title="Reset override"
              disabled={busy}
              onClick={onReset}
            >
              <RotateCcwIcon />
            </Button>
          ) : null}
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Save pattern ${entry.effectiveRule.id}`}
            title="Save pattern"
            disabled={!canSave || busy}
            onClick={onSave}
          >
            {busy ? <CheckIcon /> : <SaveIcon />}
          </Button>
        </div>
      </div>
    </article>
  );
}

/**
 * Edits one server-owned physical project profile. The caller may provide the
 * inherited/effective snapshots; writes still always target the supplied scope.
 */
export function ProjectPatternsPanel({
  environmentId,
  scope,
  inheritedRules,
  effectiveRules,
  physicalProjectKey,
  connectionState,
}: {
  readonly environmentId: EnvironmentId;
  readonly scope: AxisContextProjectScope;
  readonly inheritedRules?: ReadonlyArray<AxisProjectRule>;
  readonly effectiveRules?: ReadonlyArray<AxisProjectRule>;
  readonly physicalProjectKey?: string;
  readonly connectionState: ProjectOnboardingConnectionState;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyRuleId, setBusyRuleId] = useState<string | null>(null);
  const scopeMatchesEnvironment = scope.project.environmentId === environmentId;
  const query = useEnvironmentQuery(
    scopeMatchesEnvironment
      ? serverEnvironment.axisProjectProfile({ environmentId, input: { scope } })
      : null,
  );
  const replaceProfile = useAtomCommand(serverEnvironment.replaceAxisProjectProfile, {
    reportFailure: false,
  });
  const resetOverride = useAtomCommand(serverEnvironment.resetAxisProjectProfileOverride, {
    reportFailure: false,
  });
  const model = useMemo(
    () =>
      query.data === null
        ? null
        : buildProjectPatternsModel({
            profile: query.data,
            ...(inheritedRules === undefined ? {} : { inheritedRules }),
            ...(effectiveRules === undefined ? {} : { effectiveRules }),
          }),
    [effectiveRules, inheritedRules, query.data],
  );

  const finish = (
    ruleId: string,
    successTitle: string,
    result: Awaited<ReturnType<typeof replaceProfile>>,
  ) => {
    setBusyRuleId(null);
    if (result._tag === "Success") {
      setDrafts((current) => {
        if (!(ruleId in current)) return current;
        const next = { ...current };
        delete next[ruleId];
        return next;
      });
      query.refresh();
      toastManager.add({ type: "success", title: successTitle });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: "Could not update project patterns",
        description: errorMessage(result),
      });
    }
  };

  const save = async (entry: AxisProjectPatternEntry) => {
    if (model === null || busyRuleId !== null || connectionState !== "connected") return;
    const text = drafts[entry.id] ?? entry.effectiveRule.text;
    const input = buildRuleReplaceInput(model, entry.id, text);
    if (!("scope" in input)) {
      toastManager.add({ type: "error", title: input.message });
      return;
    }
    setBusyRuleId(entry.id);
    finish(entry.id, "Project pattern saved", await replaceProfile({ environmentId, input }));
  };

  const reset = async (entry: AxisProjectPatternEntry) => {
    if (model === null || busyRuleId !== null || connectionState !== "connected") return;
    const input = buildResetOverrideInput(model, entry.id);
    if (input === null) return;
    setBusyRuleId(entry.id);
    finish(entry.id, "Project override reset", await resetOverride({ environmentId, input }));
  };

  if (!scopeMatchesEnvironment) {
    return (
      <SettingsSection title="Patterns">
        <div className="px-3 py-4 text-sm text-muted-foreground sm:px-4">
          The selected project member belongs to another environment.
        </div>
      </SettingsSection>
    );
  }
  if (query.isPending && model === null) {
    return (
      <SettingsSection title="Patterns">
        <div className="px-3 py-4 text-sm text-muted-foreground sm:px-4">
          Loading project patterns...
        </div>
      </SettingsSection>
    );
  }
  if (query.error !== null) {
    return (
      <SettingsSection title="Patterns">
        <div className="px-3 py-4 text-sm text-destructive sm:px-4">{query.error}</div>
        <Button size="xs" variant="outline" className="m-4" onClick={query.refresh}>
          Refresh profile
        </Button>
      </SettingsSection>
    );
  }
  if (model === null) {
    return (
      <SettingsSection title="Patterns">
        <div className="px-3 py-4 text-sm text-muted-foreground sm:px-4">
          No project profile available.
        </div>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection
      title="Patterns"
      description={
        physicalProjectKey === undefined
          ? `Revision ${model.revision}`
          : `Physical member ${physicalProjectKey} · revision ${model.revision}`
      }
    >
      <p className="px-4 py-3 text-xs text-muted-foreground">
        Project rules only. Inherited and effective rules are not available in this view yet.
        {connectionState !== "connected" ? " Reconnect the selected environment to edit." : ""}
      </p>
      {model.rules.length === 0 ? (
        <div className="px-3 py-4 text-sm text-muted-foreground sm:px-4">No patterns found.</div>
      ) : (
        model.rules.map((entry) => (
          <PatternRow
            key={entry.id}
            entry={entry}
            source={sourceLabel(entry, model.sources)}
            value={drafts[entry.id] ?? entry.effectiveRule.text}
            busy={busyRuleId !== null || connectionState !== "connected"}
            onChange={(value) => setDrafts((current) => ({ ...current, [entry.id]: value }))}
            onSave={() => void save(entry)}
            onReset={() => void reset(entry)}
          />
        ))
      )}
    </SettingsSection>
  );
}
