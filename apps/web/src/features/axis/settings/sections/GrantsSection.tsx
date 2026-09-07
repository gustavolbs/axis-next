import { useState } from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";

import {
  axisProviderInstanceLocatorKey,
  AxisContextId,
  AxisProviderAccessGrantId,
} from "@t3tools/contracts";

import { randomUUID } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { removeAxisProviderAccessGrant } from "../AxisSettings.logic";
import type { AxisSettingsLoaded } from "../useAxisSettings";

export function GrantsSection({ model }: { readonly model: AxisSettingsLoaded }) {
  const {
    snapshot,
    saving,
    save,
    providerByKey,
    providerOwnerByKey,
    providers,
    providerLabel,
    contextNames,
    companies,
    personalContext,
  } = model;
  const [grantProvider, setGrantProvider] = useState("");
  const [grantCompany, setGrantCompany] = useState("");

  const personalProviderOptions = providers.filter(
    (provider) => providerOwnerByKey.get(provider.key) === personalContext?.id,
  );
  const duplicateGrant = snapshot.catalog.providerAccessGrants.some(
    (grant) =>
      grant.status === "active" &&
      grant.targetContextId === grantCompany &&
      axisProviderInstanceLocatorKey(grant.provider) === grantProvider,
  );

  const addGrant = async () => {
    const selected = providerByKey.get(grantProvider);
    if (!personalContext || !selected || !grantCompany || duplicateGrant) return;
    const now = new Date().toISOString();
    const saved = await save(
      snapshot,
      {
        ...snapshot.catalog,
        providerAccessGrants: [
          ...snapshot.catalog.providerAccessGrants,
          {
            id: AxisProviderAccessGrantId.make(
              `provider_grant_${randomUUID().replaceAll("-", "")}`,
            ),
            ownerContextId: personalContext.id,
            targetContextId: AxisContextId.make(grantCompany),
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
    if (saved) setGrantProvider("");
  };

  return (
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
            value={grantProvider}
            onValueChange={(value) => {
              if (value !== null) setGrantProvider(value);
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
            value={grantCompany}
            onValueChange={(value) => {
              if (value !== null) setGrantCompany(value);
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
            disabled={saving || !grantProvider || !grantCompany || duplicateGrant}
            onClick={() => void addGrant()}
          >
            <PlusIcon /> Grant
          </Button>
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
