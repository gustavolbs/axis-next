import { useState } from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";

import { AxisContextId } from "@t3tools/contracts";

import { randomUUID } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { removeAxisCompany } from "../AxisSettings.logic";
import type { AxisSettingsLoaded } from "../useAxisSettings";

export function ContextsSection({ model }: { readonly model: AxisSettingsLoaded }) {
  const { snapshot, saving, save } = model;
  const [companyName, setCompanyName] = useState("");

  const addCompany = async () => {
    const name = companyName.trim();
    if (!name) return;
    const now = new Date().toISOString();
    const id = AxisContextId.make(`company_${randomUUID().replaceAll("-", "")}`);
    const saved = await save(
      snapshot,
      {
        ...snapshot.catalog,
        contexts: [
          ...snapshot.catalog.contexts,
          { id, kind: "company", name, createdAt: now, updatedAt: now },
        ],
      },
      "Company context added",
    );
    if (saved) setCompanyName("");
  };

  return (
    <SettingsSection
      id="axis-contexts"
      title="Personal & Companies"
      description="Each Company is an isolated work and data context. Nothing crosses between them."
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
                onClick={() =>
                  void save(
                    snapshot,
                    removeAxisCompany(snapshot.catalog, context.id),
                    "Company context removed",
                  )
                }
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
  );
}
