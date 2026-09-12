import { useEffect, useMemo, useState } from "react";
import { CheckCircle2Icon, PauseCircleIcon, SparklesIcon } from "lucide-react";

import type {
  AxisHermesProvider,
  AxisLearningEngineStatus,
  EnvironmentId,
} from "@t3tools/contracts";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "~/hooks/useSettings";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";

const HERMES_PRESETS: ReadonlyArray<{
  readonly value: AxisHermesProvider;
  readonly label: string;
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
  readonly models: ReadonlyArray<string>;
}> = [
  {
    value: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    models: ["gpt-5.4-mini", "gpt-5.4", "gpt-4.1-mini"],
  },
  {
    value: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    models: ["openai/gpt-5.4-mini", "anthropic/claude-sonnet-4-6", "google/gemini-2.5-flash"],
  },
  {
    value: "ollama",
    label: "Ollama (local)",
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKeyEnv: "OLLAMA_API_KEY",
    models: ["llama3.2", "qwen2.5-coder:7b", "mistral"],
  },
  {
    value: "custom",
    label: "Custom OpenAI-compatible API",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    models: [],
  },
];

const presetFor = (provider: AxisHermesProvider) =>
  HERMES_PRESETS.find((preset) => preset.value === provider) ?? HERMES_PRESETS[0]!;

export function AxisHermesSettings({
  environmentId,
  engineStatus,
  disabled = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly engineStatus?: AxisLearningEngineStatus | null;
  readonly disabled?: boolean;
}) {
  const settings = useEnvironmentSettings(environmentId, (value) => value.axisHermes);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [customModel, setCustomModel] = useState(settings.model);
  const [customBaseUrl, setCustomBaseUrl] = useState(settings.baseUrl);
  const [customApiKeyEnv, setCustomApiKeyEnv] = useState(settings.apiKeyEnv);
  const preset = presetFor(settings.provider);
  const modelOptions = useMemo(
    () =>
      preset.models.includes(settings.model) ? preset.models : [...preset.models, settings.model],
    [preset.models, settings.model],
  );
  const modelSelectValue = preset.models.includes(settings.model) ? settings.model : "custom";

  useEffect(() => {
    setCustomModel(settings.model);
    setCustomBaseUrl(settings.baseUrl);
    setCustomApiKeyEnv(settings.apiKeyEnv);
  }, [settings.apiKeyEnv, settings.baseUrl, settings.model]);

  const save = (patch: {
    readonly enabled?: boolean;
    readonly provider?: AxisHermesProvider;
    readonly model?: string;
    readonly baseUrl?: string;
    readonly apiKeyEnv?: string;
  }) => {
    updateSettings({ axisHermes: patch });
  };

  const chooseProvider = (value: string | null) => {
    if (!value) return;
    const next = presetFor(value as AxisHermesProvider);
    save({
      provider: next.value,
      model: next.models[0] ?? settings.model,
      baseUrl: next.baseUrl,
      apiKeyEnv: next.apiKeyEnv,
    });
  };

  const engineBadge =
    engineStatus?.availability === "available" ? (
      <Badge variant="success">
        <CheckCircle2Icon /> Ready
      </Badge>
    ) : engineStatus?.availability === "offline" ? (
      <Badge variant="error">Needs setup</Badge>
    ) : settings.enabled ? (
      <Badge variant="secondary">Automatic</Badge>
    ) : (
      <Badge variant="outline">
        <PauseCircleIcon /> Paused
      </Badge>
    );

  return (
    <SettingsSection
      id="axis-hermes"
      title="Hermes"
      description="Automatic learning is on by default. Choose where it gets its model; every suggestion still waits for your review."
      headerAction={engineBadge}
    >
      <SettingsRow
        title="Automatic learning"
        description="Runs after completed work and other project evidence."
        control={
          <Switch
            checked={settings.enabled}
            disabled={disabled}
            aria-label="Enable automatic Hermes learning"
            onCheckedChange={(enabled) => save({ enabled })}
          />
        }
      />
      <SettingsRow
        title="Model provider"
        description="Credentials are read from this environment's provider settings."
        control={
          <Select value={settings.provider} disabled={disabled} onValueChange={chooseProvider}>
            <SelectTrigger size="sm" className="w-56" aria-label="Hermes model provider">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {HERMES_PRESETS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Model"
        description="Pick a common model or enter another compatible model id."
        control={
          <div className="flex w-full min-w-0 flex-col gap-2 sm:w-72">
            <Select
              value={modelSelectValue}
              disabled={disabled || preset.models.length === 0}
              onValueChange={(value) => {
                if (value && value !== "custom") save({ model: value });
              }}
            >
              <SelectTrigger size="sm" aria-label="Hermes model">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {modelOptions.map((model) => (
                  <SelectItem key={model} value={model}>
                    {model}
                  </SelectItem>
                ))}
                {preset.models.length > 0 ? (
                  <SelectItem value="custom">Custom model id</SelectItem>
                ) : null}
              </SelectPopup>
            </Select>
            <Input
              value={customModel}
              disabled={disabled}
              aria-label="Hermes model id"
              placeholder="Model id"
              onChange={(event) => setCustomModel(event.target.value)}
              onBlur={() => {
                const value = customModel.trim();
                if (value && value !== settings.model) save({ model: value });
              }}
            />
          </div>
        }
      />
      {settings.provider === "custom" ? (
        <>
          <SettingsRow
            title="API base URL"
            description="The endpoint must expose an OpenAI-compatible chat API."
            control={
              <Input
                className="w-full sm:w-72"
                disabled={disabled}
                aria-label="Hermes API base URL"
                value={customBaseUrl}
                onChange={(event) => setCustomBaseUrl(event.target.value)}
                onBlur={() => {
                  const value = customBaseUrl.trim();
                  if (value && value !== settings.baseUrl) save({ baseUrl: value });
                }}
              />
            }
          />
          <SettingsRow
            title="API key variable"
            description="Only the variable name is stored here; the secret stays private."
            control={
              <Input
                className="w-full font-mono sm:w-72"
                value={customApiKeyEnv}
                disabled={disabled}
                aria-label="Hermes API key environment variable"
                onChange={(event) => setCustomApiKeyEnv(event.target.value)}
                onBlur={() => {
                  const value = customApiKeyEnv.trim();
                  if (value && value !== settings.apiKeyEnv) save({ apiKeyEnv: value });
                }}
              />
            }
          />
        </>
      ) : null}
      {engineStatus?.message ? (
        <div className="flex items-start gap-2 border-t border-border/60 px-3 py-3 text-xs text-muted-foreground">
          <SparklesIcon className="mt-0.5 size-3.5 shrink-0 text-primary" />
          <span>{engineStatus.message}</span>
        </div>
      ) : null}
    </SettingsSection>
  );
}
