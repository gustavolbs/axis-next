/**
 * Everything the Axis settings screens read and write.
 *
 * The catalog is one document with one revision, so every screen must edit
 * the same loaded snapshot and save through the same optimistic-concurrency
 * path. Splitting the screens apart therefore could not mean splitting the
 * data: they share this hook and differ only in what they render.
 *
 * @module features/axis/settings/useAxisSettings
 */
import { useMemo, useState } from "react";

import {
  axisProviderInstanceLocatorKey,
  type AxisContextCatalog,
  type AxisContextCatalogSnapshot,
  type AxisProviderInstanceLocator,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { environmentCatalog } from "~/connection/catalog";
import { useProjects } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastManager } from "~/components/ui/toast";

export interface AxisProviderOption {
  readonly locator: AxisProviderInstanceLocator;
  readonly key: string;
  readonly label: string;
}

export function useAxisSettings() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const { environments } = useEnvironments();
  const projects = useProjects();
  const axisSupported = primaryEnvironment?.serverConfig?.environment.capabilities.axis === true;
  const query = useEnvironmentQuery(
    environmentId === null || !axisSupported
      ? null
      : serverEnvironment.axisContextCatalog({ environmentId, input: {} }),
  );
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const replaceCatalog = useAtomCommand(serverEnvironment.replaceAxisContextCatalog, {
    reportFailure: false,
  });
  const [saving, setSaving] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);

  const snapshot = query.data;
  const contextNames = useMemo(
    () => new Map(snapshot?.catalog.contexts.map((context) => [context.id, context.name]) ?? []),
    [snapshot],
  );
  const providers = useMemo<ReadonlyArray<AxisProviderOption>>(
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
  const localProjects = projects.filter((project) => project.environmentId === environmentId);
  const projectContextById = useMemo(
    () =>
      new Map(
        snapshot?.catalog.projectBindings
          .filter((binding) => binding.project.environmentId === environmentId)
          .map((binding) => [binding.project.projectId, binding.contextId]) ?? [],
      ),
    [environmentId, snapshot],
  );
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

  const reconnect = async () => {
    if (environmentId === null || reconnecting) return;
    setReconnecting(true);
    const result = await retryEnvironment(environmentId);
    setReconnecting(false);
    if (result._tag === "Success") query.refresh();
  };

  return {
    environmentId,
    primaryEnvironment,
    axisSupported,
    query,
    snapshot,
    saving,
    reconnecting,
    reconnect,
    save,
    providers,
    providerByKey,
    providerOwnerByKey,
    providerLabel,
    contextNames,
    companies,
    personalContext,
    localProjects,
    projectContextById,
  };
}

export type AxisSettingsModel = ReturnType<typeof useAxisSettings>;

/** Narrowed to the loaded state, which is all any section screen renders. */
export type AxisSettingsLoaded = AxisSettingsModel & {
  readonly environmentId: NonNullable<AxisSettingsModel["environmentId"]>;
  readonly snapshot: AxisContextCatalogSnapshot;
};
