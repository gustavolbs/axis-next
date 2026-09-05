import { useMemo, useState } from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";

import {
  axisProviderInstanceLocatorKey,
  AxisCapabilityId,
  AxisContextId,
  AxisProviderAccessGrantId,
  type AxisCapabilityKind,
  type AxisContextCatalog,
  type AxisContextCatalogSnapshot,
  type AxisProviderInstanceLocator,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { randomUUID } from "~/lib/utils";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import {
  removeAxisCompany,
  removeAxisProviderAccessGrant,
  setAxisProviderOwner,
} from "./AxisSettings.logic";

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
  const { environments } = useEnvironments();
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
  const [capabilityProvider, setCapabilityProvider] = useState("");
  const [providerGrantProvider, setProviderGrantProvider] = useState("");
  const [providerGrantCompany, setProviderGrantCompany] = useState("");
  const [saving, setSaving] = useState(false);

  const snapshot = query.data;
  const contextNames = useMemo(
    () => new Map(snapshot?.catalog.contexts.map((context) => [context.id, context.name]) ?? []),
    [snapshot],
  );
  const providers = useMemo(
    () =>
      environments.flatMap((environment) =>
        (environment.serverConfig?.providers ?? []).map((provider) => {
          const locator = {
            environmentId: environment.environmentId,
            instanceId: provider.instanceId,
          };
          return {
            locator,
            key: axisProviderInstanceLocatorKey(locator),
            label: `${provider.displayName ?? provider.instanceId} · ${environment.label}`,
          };
        }),
      ),
    [environments],
  );
  const providerByKey = useMemo(
    () => new Map(providers.map((provider) => [provider.key, provider])),
    [providers],
  );
  const companies =
    snapshot?.catalog.contexts.filter((context) => context.kind === "company") ?? [];
  const personalContext = snapshot?.catalog.contexts.find((context) => context.kind === "personal");
  const providerOwnerByKey = useMemo(
    () =>
      new Map(
        snapshot?.catalog.providerOwnerships.map((ownership) => [
          axisProviderInstanceLocatorKey(ownership.provider),
          ownership.contextId,
        ]) ?? [],
      ),
    [snapshot],
  );
  const ownedProviders = providers.filter((provider) => providerOwnerByKey.has(provider.key));
  const personalProviderOptions = providers.filter(
    (provider) => providerOwnerByKey.get(provider.key) === personalContext?.id,
  );
  const duplicateProviderGrant = snapshot?.catalog.providerAccessGrants.some(
    (grant) =>
      grant.status === "active" &&
      grant.targetContextId === providerGrantCompany &&
      axisProviderInstanceLocatorKey(grant.provider) === providerGrantProvider,
  );

  const providerLabel = (provider: AxisProviderInstanceLocator) => {
    const key = axisProviderInstanceLocatorKey(provider);
    return providerByKey.get(key)?.label ?? `${provider.instanceId} · ${provider.environmentId}`;
  };

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
    const selected = providerByKey.get(capabilityProvider);
    if (!selected || !providerOwnerByKey.has(selected.key)) return;
    const now = new Date().toISOString();
    const saved = await save(
      snapshot,
      {
        ...snapshot.catalog,
        capabilities: [
          ...snapshot.catalog.capabilities,
          {
            id: AxisCapabilityId.make(entityId("capability")),
            provider: selected.locator,
            kind: capabilityKind,
            name: capabilityName.trim(),
            enabled: true,
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

  const addProviderGrant = async () => {
    if (
      !snapshot ||
      !personalContext ||
      !providerGrantProvider ||
      !providerGrantCompany ||
      duplicateProviderGrant
    ) {
      return;
    }
    const selected = providerByKey.get(providerGrantProvider);
    if (!selected) return;
    const now = new Date().toISOString();
    const saved = await save(
      snapshot,
      {
        ...snapshot.catalog,
        providerAccessGrants: [
          ...snapshot.catalog.providerAccessGrants,
          {
            id: AxisProviderAccessGrantId.make(entityId("provider_grant")),
            ownerContextId: personalContext.id,
            targetContextId: AxisContextId.make(providerGrantCompany),
            provider: selected.locator,
            status: "active",
            createdAt: now,
            updatedAt: now,
            revokedAt: null,
          },
        ],
      },
      "Personal provider granted to company",
    );
    if (saved) setProviderGrantProvider("");
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
        <SettingsSection title="Axis" description="Contexts, providers, MCPs, and skills.">
          <SettingsRow
            title={query.error ? "Could not load Axis settings" : "Loading Axis settings"}
            description={
              query.error
                ? "The selected environment is offline or its backend does not include Axis yet. Restart or update that environment, then reload."
                : undefined
            }
            status={query.error ?? undefined}
            control={query.error ? <Button onClick={query.refresh}>Reload</Button> : undefined}
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
        description="Each Company is an isolated work and data context."
      >
        {snapshot.catalog.contexts.map((context) => (
          <SettingsRow
            key={context.id}
            title={context.name}
            description={
              context.kind === "personal"
                ? "Your private context. It cannot read Company data."
                : "An isolated Company workspace."
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
          title="Add Company"
          description="Creates a new isolated context with no inherited providers or data."
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
        id="axis-provider-ownership"
        title="Provider ownership"
        description="Assign every configured provider account to Personal or exactly one Company."
      >
        {providers.length === 0 ? (
          <SettingsRow
            title="No providers found"
            description="Configure a provider connection before assigning its Axis owner."
          />
        ) : (
          providers.map((provider) => {
            const owner = providerOwnerByKey.get(provider.key);
            const hasCapabilities = snapshot.catalog.capabilities.some(
              (capability) => axisProviderInstanceLocatorKey(capability.provider) === provider.key,
            );
            return (
              <SettingsRow
                key={provider.key}
                title={provider.label}
                status={owner ? (contextNames.get(owner) ?? owner) : "Unassigned"}
                control={
                  <Select
                    value={owner ?? "unassigned"}
                    onValueChange={(value) => {
                      if (value === null) return;
                      void save(
                        snapshot,
                        setAxisProviderOwner(
                          snapshot.catalog,
                          provider.locator,
                          value === "unassigned" ? null : AxisContextId.make(value),
                        ),
                        "Provider owner updated",
                      );
                    }}
                  >
                    <SelectTrigger className="w-44" aria-label={`Owner of ${provider.label}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="unassigned" disabled={hasCapabilities}>
                        Unassigned
                      </SelectItem>
                      {snapshot.catalog.contexts.map((context) => (
                        <SelectItem key={context.id} value={context.id}>
                          {context.name}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                }
              />
            );
          })
        )}
      </SettingsSection>

      <SettingsSection
        id="axis-capabilities"
        title="Provider capabilities"
        description="Manage MCPs, skills, instructions, and preferences on the provider that loads them."
      >
        {snapshot.catalog.capabilities.length === 0 ? (
          <SettingsRow
            title="No capabilities registered"
            description="Register a capability on an assigned provider. It follows that provider wherever access is allowed."
          />
        ) : (
          snapshot.catalog.capabilities.map((capability) => (
            <SettingsRow
              key={capability.id}
              title={capability.name}
              description={`${CAPABILITY_LABELS[capability.kind]} · ${providerLabel(capability.provider)}`}
              status={capability.enabled ? "Enabled" : "Disabled"}
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
                          workHubSources: snapshot.catalog.workHubSources.filter(
                            (source) => source.capabilityId !== capability.id,
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
          title="Register capability"
          description="Connection details and secrets remain in the provider environment."
        >
          <div className="grid gap-2 py-3 sm:grid-cols-[9rem_minmax(10rem,1fr)_minmax(12rem,1fr)_auto] sm:items-center">
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
              value={capabilityProvider}
              onValueChange={(value) => {
                if (value !== null) setCapabilityProvider(value);
              }}
            >
              <SelectTrigger aria-label="Capability provider">
                <SelectValue placeholder="Provider" />
              </SelectTrigger>
              <SelectPopup>
                {ownedProviders.map((provider) => (
                  <SelectItem key={provider.key} value={provider.key}>
                    {provider.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Button
              size="sm"
              disabled={saving || !capabilityName.trim() || !capabilityProvider}
              onClick={() => void addCapability()}
            >
              <PlusIcon /> Add
            </Button>
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        id="axis-provider-access"
        title="Personal provider access"
        description="Allow one Company to use a provider owned by Personal. The provider's enabled MCPs, skills, instructions, and preferences travel with it."
      >
        {snapshot.catalog.providerAccessGrants.map((grant) => (
          <SettingsRow
            key={grant.id}
            title={providerLabel(grant.provider)}
            description={`Available to ${contextNames.get(grant.targetContextId) ?? grant.targetContextId}`}
            status={grant.status === "active" ? "Active" : "Revoked"}
            control={
              <Button
                size="icon-sm"
                variant="ghost-muted"
                disabled={saving}
                aria-label={`Remove access to ${providerLabel(grant.provider)}`}
                onClick={() =>
                  void save(
                    snapshot,
                    removeAxisProviderAccessGrant(snapshot.catalog, grant.id),
                    "Provider access removed",
                  )
                }
              >
                <Trash2Icon />
              </Button>
            }
          />
        ))}
        <SettingsRow
          title="Grant provider access"
          description="Company work sent through a Personal provider may be processed under your personal account. No Company can see another Company's data."
          status={`Catalog revision ${snapshot.revision}`}
        >
          <div className="grid gap-2 py-3 sm:grid-cols-[minmax(12rem,1fr)_minmax(10rem,1fr)_auto] sm:items-center">
            <Select
              value={providerGrantProvider}
              onValueChange={(value) => {
                if (value !== null) setProviderGrantProvider(value);
              }}
            >
              <SelectTrigger aria-label="Personal provider">
                <SelectValue placeholder="Personal provider" />
              </SelectTrigger>
              <SelectPopup>
                {personalProviderOptions.map((provider) => (
                  <SelectItem key={provider.key} value={provider.key}>
                    {provider.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Select
              value={providerGrantCompany}
              onValueChange={(value) => {
                if (value !== null) setProviderGrantCompany(value);
              }}
            >
              <SelectTrigger aria-label="Target Company">
                <SelectValue placeholder="Company" />
              </SelectTrigger>
              <SelectPopup>
                {companies.map((company) => (
                  <SelectItem key={company.id} value={company.id}>
                    {company.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Button
              size="sm"
              disabled={
                saving || !providerGrantProvider || !providerGrantCompany || duplicateProviderGrant
              }
              onClick={() => void addProviderGrant()}
            >
              <PlusIcon /> Grant
            </Button>
          </div>
        </SettingsRow>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
