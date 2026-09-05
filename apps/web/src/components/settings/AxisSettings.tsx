import { useMemo, useState } from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";

import {
  AxisCapabilityId,
  AxisContextId,
  type AxisContextCatalog,
  type AxisContextCatalogSnapshot,
  type AxisCapabilityKind,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { randomUUID } from "~/lib/utils";
import { serverEnvironment } from "~/state/server";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { removeAxisCompany } from "./AxisSettings.logic";

const CAPABILITY_LABELS: Readonly<Record<AxisCapabilityKind, string>> = {
  mcp: "MCP",
  skill: "Skill",
  instructions: "Instructions",
  preferences: "Preferences",
};

function entityId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function AxisSettingsPanel() {
  const environmentId = usePrimaryEnvironmentId();
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.axisContextCatalog({ environmentId, input: {} }),
  );
  const replaceCatalog = useAtomCommand(serverEnvironment.replaceAxisContextCatalog, {
    reportFailure: false,
  });
  const [companyName, setCompanyName] = useState("");
  const [capabilityName, setCapabilityName] = useState("");
  const [capabilityKind, setCapabilityKind] = useState<AxisCapabilityKind>("mcp");
  const [capabilityOwner, setCapabilityOwner] = useState<string>("personal");
  const [portable, setPortable] = useState(false);
  const [saving, setSaving] = useState(false);

  const snapshot = query.data;
  const contextNames = useMemo(
    () => new Map(snapshot?.catalog.contexts.map((context) => [context.id, context.name]) ?? []),
    [snapshot],
  );

  const save = async (
    current: AxisContextCatalogSnapshot,
    catalog: AxisContextCatalog,
    successTitle: string,
  ) => {
    if (environmentId === null || saving) return false;
    setSaving(true);
    const result = await replaceCatalog({
      environmentId,
      input: { expectedRevision: current.revision, catalog },
    });
    setSaving(false);
    if (result._tag === "Success") {
      query.refresh();
      toastManager.add({ type: "success", title: successTitle });
      return true;
    }
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not update Axis settings",
        description:
          error instanceof Error && error.message
            ? error.message
            : "Refresh the catalog and try again.",
      });
    }
    return false;
  };

  const addCompany = async () => {
    if (!snapshot || !companyName.trim()) return;
    const now = new Date().toISOString();
    const id = AxisContextId.make(entityId("company"));
    const saved = await save(
      snapshot,
      {
        ...snapshot.catalog,
        contexts: [
          ...snapshot.catalog.contexts,
          { id, kind: "company", name: companyName.trim(), createdAt: now, updatedAt: now },
        ],
      },
      "Company context added",
    );
    if (saved) setCompanyName("");
  };

  const addCapability = async () => {
    if (!snapshot || !capabilityName.trim()) return;
    const now = new Date().toISOString();
    const ownerContextId = AxisContextId.make(capabilityOwner);
    const saved = await save(
      snapshot,
      {
        ...snapshot.catalog,
        capabilities: [
          ...snapshot.catalog.capabilities,
          {
            id: AxisCapabilityId.make(entityId("capability")),
            ownerContextId,
            kind: capabilityKind,
            name: capabilityName.trim(),
            enabled: true,
            portableToCompanies: ownerContextId === "personal" && portable,
            compatibleDrivers: [],
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
      `${CAPABILITY_LABELS[capabilityKind]} added`,
    );
    if (saved) setCapabilityName("");
  };

  const removeCompany = (contextId: AxisContextId) => {
    if (!snapshot) return;
    void save(snapshot, removeAxisCompany(snapshot.catalog, contextId), "Company context removed");
  };

  if (environmentId === null) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Axis" description="Connect a primary environment to manage Axis.">
          <SettingsRow title="No primary environment" />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  if (!snapshot) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Axis" description="Contexts, MCPs, skills, and sharing rules.">
          <SettingsRow
            title={query.error ? "Could not load Axis settings" : "Loading Axis settings"}
            description={query.error ?? undefined}
            control={query.error ? <Button onClick={query.refresh}>Retry</Button> : undefined}
          />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer>
      <SettingsSection
        id="axis-contexts"
        title="Personal & Companies"
        description="Each company is isolated. Personal providers and capabilities only enter a company through an explicit grant."
      >
        {snapshot.catalog.contexts.map((context) => (
          <SettingsRow
            key={context.id}
            title={context.name}
            description={
              context.kind === "personal"
                ? "Your private context. It cannot read company data."
                : "An isolated company workspace."
            }
            status={context.kind === "personal" ? "Personal" : "Company"}
            control={
              context.kind === "company" ? (
                <Button
                  size="icon-sm"
                  variant="ghost-muted"
                  disabled={saving}
                  aria-label={`Remove ${context.name}`}
                  onClick={() => removeCompany(context.id)}
                >
                  <Trash2Icon />
                </Button>
              ) : undefined
            }
          />
        ))}
        <SettingsRow
          title="Add company"
          description="Creates a new isolated context with no inherited providers, MCPs, skills, or data."
          control={
            <div className="flex w-full gap-2 sm:w-80">
              <Input
                value={companyName}
                onChange={(event) => setCompanyName(event.target.value)}
                placeholder="Company name"
                aria-label="Company name"
              />
              <Button
                size="sm"
                disabled={saving || !companyName.trim()}
                onClick={() => void addCompany()}
              >
                <PlusIcon /> Add
              </Button>
            </div>
          }
        />
      </SettingsSection>

      <SettingsSection
        id="axis-capabilities"
        title="Agent capabilities"
        description="Manage MCPs, skills, instructions, and preferences by owner context. Secrets stay in the provider environment."
      >
        {snapshot.catalog.capabilities.length === 0 ? (
          <SettingsRow
            title="No capabilities registered"
            description="Add an MCP or skill here to control where it is enabled and whether Personal may share it with companies."
          />
        ) : (
          snapshot.catalog.capabilities.map((capability) => (
            <SettingsRow
              key={capability.id}
              title={capability.name}
              description={`${CAPABILITY_LABELS[capability.kind]} · ${contextNames.get(capability.ownerContextId) ?? capability.ownerContextId}`}
              status={
                capability.portableToCompanies
                  ? "Eligible for explicit company grants"
                  : "Only available in its owner context"
              }
              control={
                <div className="flex items-center gap-2">
                  <Switch
                    checked={capability.enabled}
                    disabled={saving}
                    aria-label={`Enable ${capability.name}`}
                    onCheckedChange={(enabled) => {
                      const now = new Date().toISOString();
                      void save(
                        snapshot,
                        {
                          ...snapshot.catalog,
                          capabilities: snapshot.catalog.capabilities.map((candidate) =>
                            candidate.id === capability.id
                              ? { ...candidate, enabled, updatedAt: now }
                              : candidate,
                          ),
                        },
                        enabled ? "Capability enabled" : "Capability disabled",
                      );
                    }}
                  />
                  <Button
                    size="icon-sm"
                    variant="ghost-muted"
                    disabled={saving}
                    aria-label={`Remove ${capability.name}`}
                    onClick={() =>
                      void save(
                        snapshot,
                        {
                          ...snapshot.catalog,
                          capabilities: snapshot.catalog.capabilities.filter(
                            (candidate) => candidate.id !== capability.id,
                          ),
                          capabilityGrants: snapshot.catalog.capabilityGrants.filter(
                            (grant) => grant.capabilityId !== capability.id,
                          ),
                        },
                        "Capability removed",
                      )
                    }
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              }
            />
          ))
        )}
        <SettingsRow
          title="Register MCP or skill"
          description="Register ownership first; connection and provider-specific configuration remain on the owning environment."
        >
          <div className="grid gap-2 py-3 sm:grid-cols-[9rem_minmax(10rem,1fr)_minmax(10rem,1fr)_auto_auto] sm:items-center">
            <Select
              value={capabilityKind}
              onValueChange={(value) => setCapabilityKind(value as AxisCapabilityKind)}
            >
              <SelectTrigger aria-label="Capability type">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {Object.entries(CAPABILITY_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Input
              value={capabilityName}
              onChange={(event) => setCapabilityName(event.target.value)}
              placeholder="Capability name"
              aria-label="Capability name"
            />
            <Select
              value={capabilityOwner}
              onValueChange={(value) => {
                if (value !== null) setCapabilityOwner(value);
              }}
            >
              <SelectTrigger aria-label="Owner context">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {snapshot.catalog.contexts.map((context) => (
                  <SelectItem key={context.id} value={context.id}>
                    {context.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch
                checked={portable}
                disabled={capabilityOwner !== "personal"}
                onCheckedChange={setPortable}
              />{" "}
              Shareable
            </label>
            <Button
              size="sm"
              disabled={saving || !capabilityName.trim()}
              onClick={() => void addCapability()}
            >
              <PlusIcon /> Add
            </Button>
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        id="axis-provider-access"
        title="Provider & company grants"
        description="Provider access and capability access are granted separately. Company A never receives visibility into Company B."
      >
        <SettingsRow
          title="Grant editor"
          description="The catalog model and enforcement are active. The guided provider/capability grant editor is the next UI slice."
          status={`Catalog revision ${snapshot.revision}`}
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
