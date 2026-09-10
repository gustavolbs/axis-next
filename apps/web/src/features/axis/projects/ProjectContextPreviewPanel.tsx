import { useEffect, useMemo, useState } from "react";
import { RefreshCwIcon } from "lucide-react";

import type {
  AxisContextProjectScope,
  AxisProjectContextPreviewInput,
  AxisProjectRule,
  EnvironmentConnectionState,
  EnvironmentId,
  ModelSelection,
} from "@t3tools/contracts";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";

type PreviewConnectionState = EnvironmentConnectionState | "unauthorized";
type PreviewSubmission = {
  readonly key: string;
  readonly input: AxisProjectContextPreviewInput;
};

const scopeKey = (scope: AxisContextProjectScope) =>
  `${scope.contextId}\u0000${scope.project.environmentId}\u0000${scope.project.projectId}`;

const originLabel = (origin: AxisProjectRule["origin"]): string =>
  origin === "manual" ? "Override" : origin.charAt(0).toUpperCase() + origin.slice(1);

const sourceLabel = (source: string) => source.trim() || "Unreferenced source";

function RuleRow({ rule }: { readonly rule: AxisProjectRule }) {
  return (
    <article className="space-y-2 border-b border-border/50 px-3 py-3 last:border-b-0 sm:px-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{rule.id}</span>
        <Badge variant={rule.origin === "manual" ? "warning" : "outline"} size="sm">
          {originLabel(rule.origin)}
        </Badge>
        <Badge variant="secondary" size="sm">
          {rule.effect}
        </Badge>
      </div>
      <p className="whitespace-pre-wrap text-sm text-muted-foreground">{rule.text}</p>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>Source: {sourceLabel(rule.sourceRef)}</span>
        {rule.paths.length > 0 ? <span>Paths: {rule.paths.join(", ")}</span> : null}
      </div>
    </article>
  );
}

export function ProjectContextPreviewPanel({
  environmentId,
  scope,
  modelSelection,
  connectionState,
}: {
  readonly environmentId: EnvironmentId;
  readonly scope: AxisContextProjectScope;
  readonly modelSelection: ModelSelection | null;
  readonly connectionState: PreviewConnectionState;
}) {
  const [step, setStep] = useState("verify");
  const [pathsText, setPathsText] = useState("");
  const [submission, setSubmission] = useState<PreviewSubmission | null>(null);
  const currentScopeKey = scopeKey(scope);
  const scopeMatchesEnvironment = scope.project.environmentId === environmentId;
  const connected = scopeMatchesEnvironment && connectionState === "connected";
  const paths = useMemo(
    () =>
      pathsText
        .split(",")
        .map((path) => path.trim())
        .filter((path) => path.length > 0),
    [pathsText],
  );
  const draftKey = JSON.stringify([
    currentScopeKey,
    environmentId,
    modelSelection?.instanceId ?? null,
    modelSelection?.model ?? null,
    step.trim(),
    paths,
  ]);
  const activeSubmission = submission?.key === draftKey ? submission : null;
  const query = useEnvironmentQuery(
    connected && activeSubmission !== null
      ? serverEnvironment.axisProjectContextPreview({
          environmentId,
          input: activeSubmission.input,
        })
      : null,
  );

  useEffect(() => {
    setStep("verify");
    setPathsText("");
    setSubmission(null);
  }, [currentScopeKey]);

  const submitPreview = () => {
    if (modelSelection === null || step.trim().length === 0) return;
    if (activeSubmission !== null) {
      query.refresh();
      return;
    }
    setSubmission({
      key: draftKey,
      input: {
        scope,
        provider: {
          environmentId,
          instanceId: modelSelection.instanceId,
        },
        ...(modelSelection.model.length > 0 ? { model: modelSelection.model } : {}),
        step: step.trim(),
        paths,
      },
    });
  };

  if (!scopeMatchesEnvironment) {
    return (
      <SettingsSection title="Context preview">
        <SettingsRow
          title="Project environment mismatch"
          description="The selected physical project belongs to another environment."
        />
      </SettingsSection>
    );
  }

  if (connectionState !== "connected") {
    return (
      <SettingsSection title="Context preview">
        <SettingsRow
          title="Environment disconnected"
          description="Connect this environment to preview its effective project context."
        />
      </SettingsSection>
    );
  }

  if (modelSelection === null) {
    return (
      <SettingsSection title="Context preview">
        <SettingsRow
          title="No provider model selected"
          description="Select an available provider and model before requesting a context preview."
        />
      </SettingsSection>
    );
  }

  const controls = (
    <div className="flex flex-wrap items-end gap-2 px-3 py-3 sm:px-4">
      <label className="min-w-40 flex-1 space-y-1 text-xs text-muted-foreground">
        <span>Step</span>
        <Input
          aria-label="Preview step"
          value={step}
          onChange={(event) => setStep(event.target.value)}
          placeholder="verify"
        />
      </label>
      <label className="min-w-56 flex-[2] space-y-1 text-xs text-muted-foreground">
        <span>Paths (optional, comma separated)</span>
        <Input
          aria-label="Preview paths"
          value={pathsText}
          onChange={(event) => setPathsText(event.target.value)}
          placeholder="src/main.ts"
        />
      </label>
      <Button
        size="xs"
        variant="outline"
        disabled={query.isPending || step.trim().length === 0}
        onClick={submitPreview}
      >
        <RefreshCwIcon aria-hidden />
        Refresh
      </Button>
    </div>
  );

  if (step.trim().length === 0) {
    return (
      <SettingsSection title="Context preview" description="Choose a workflow step to inspect.">
        {controls}
        <SettingsRow
          title="Step required"
          description="Enter a step before requesting a preview."
        />
      </SettingsSection>
    );
  }

  if (query.isPending && query.data === null) {
    return (
      <SettingsSection title="Context preview">
        {controls}
        <SettingsRow title="Loading effective context" />
      </SettingsSection>
    );
  }

  if (query.error !== null) {
    return (
      <SettingsSection title="Context preview">
        {controls}
        <SettingsRow title="Could not load context preview" description={query.error} />
      </SettingsSection>
    );
  }

  if (query.data === null) {
    return (
      <SettingsSection title="Context preview">
        {controls}
        <SettingsRow
          title="No preview requested"
          description="Refresh to read the server-resolved context."
        />
      </SettingsSection>
    );
  }

  const preview = query.data;
  return (
    <SettingsSection
      title="Context preview"
      description={`${preview.provider.instanceId} · ${preview.model ?? "Default model"} · ${preview.step}`}
    >
      {controls}
      <div className="flex flex-wrap gap-2 px-3 pb-3 sm:px-4">
        <Badge variant="outline">Profile revision {preview.profileRevision}</Badge>
        <Badge variant="secondary">{preview.rules.length} rules</Badge>
        <Badge variant="secondary">{preview.sources.length} sources</Badge>
        <Badge variant={preview.conflicts.length > 0 ? "warning" : "outline"}>
          {preview.conflicts.length} conflicts
        </Badge>
      </div>
      {preview.rules.length === 0 ? (
        <SettingsRow
          title="No effective rules"
          description="The selected step and paths produced no server-resolved rules."
        />
      ) : (
        <div className="border-t border-border/50">
          {preview.rules.map((rule) => (
            <RuleRow key={rule.id} rule={rule} />
          ))}
        </div>
      )}
      <div className="space-y-2 border-t border-border/50 px-3 py-3 text-xs sm:px-4">
        <div className="font-medium">Sources</div>
        {preview.sources.length === 0 ? (
          <div className="text-muted-foreground">No source references.</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {preview.sources.map((source) => (
              <Badge key={source} variant="outline">
                {sourceLabel(source)}
              </Badge>
            ))}
          </div>
        )}
        <div className="font-medium">Learning versions</div>
        <div className="text-muted-foreground">
          {preview.learningVersionIds.length === 0
            ? "No active learning versions."
            : preview.learningVersionIds.join(", ")}
        </div>
        {preview.conflicts.length > 0 ? (
          <>
            <div className="font-medium">Conflicts</div>
            <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
              {preview.conflicts.map((conflict) => (
                <li key={conflict}>{conflict}</li>
              ))}
            </ul>
          </>
        ) : null}
        <div className="font-medium">Digest</div>
        <code className="block break-all text-muted-foreground">{preview.digest}</code>
      </div>
    </SettingsSection>
  );
}
