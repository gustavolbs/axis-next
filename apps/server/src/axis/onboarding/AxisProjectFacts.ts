// @effect-diagnostics nodeBuiltinImport:off - facts hash the bounded source inventory.
import * as NodeCrypto from "node:crypto";

import { parse as parseYaml } from "yaml";

import type {
  AxisOnboardingDigest,
  AxisOnboardingFact,
} from "../../../../../packages/contracts/src/axisOnboarding.ts";
import {
  AxisOnboardingDigestId,
  AxisOnboardingFactId,
  AxisOnboardingSourceId,
} from "../../../../../packages/contracts/src/axisOnboarding.ts";
import type { AxisProjectSource, AxisProjectSourcesResult } from "./AxisProjectSources.ts";

export interface AxisProjectFactDiagnostic {
  readonly path: string;
  readonly message: string;
  readonly status: "absent" | "failed" | "invalid";
}

export interface AxisProjectFactsResult {
  readonly digests: ReadonlyArray<AxisOnboardingDigest>;
  readonly facts: ReadonlyArray<AxisOnboardingFact>;
  readonly diagnostics: ReadonlyArray<AxisProjectFactDiagnostic>;
}

const relevantScripts = new Set(["build", "dev", "lint", "start", "test", "test:coverage", "typecheck"]);

const digest = (value: string) => NodeCrypto.createHash("sha256").update(value, "utf8").digest("hex");

const sourceId = (path: string) => AxisOnboardingSourceId.make(`source-${digest(path).slice(0, 32)}`);

const factId = (source: AxisProjectSource, key: string, value: string) =>
  AxisOnboardingFactId.make(`fact-${digest(`${source.path}\0${key}\0${value}`).slice(0, 32)}`);

const digestId = (source: AxisProjectSource, content: string) =>
  AxisOnboardingDigestId.make(`digest-${digest(`${source.path}\0${content}`).slice(0, 32)}`);

const makeFact = (source: AxisProjectSource, key: string, value: string): AxisOnboardingFact => ({
  id: factId(source, key, value),
  sourceId: sourceId(source.path),
  key,
  value,
  confidence: "explicit",
});

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

const stringList = (value: unknown): ReadonlyArray<string> | null => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return null;
  return value;
};

const workspacePatterns = (manifest: Record<string, unknown>): ReadonlyArray<string> => {
  const workspaces = manifest.workspaces;
  if (Array.isArray(workspaces)) return stringList(workspaces) ?? [];
  const object = asRecord(workspaces);
  return object === null ? [] : stringList(object.packages) ?? [];
};

const globMatches = (pattern: string, path: string): boolean => {
  const escaped = pattern.split("").map((character) => ".+?^${}()|[]\\".includes(character) ? `\\${character}` : character).join("");
  const glob = escaped.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
  return new RegExp(`^${glob.endsWith("\\/") ? glob.slice(0, -2) : glob}(?:/|$)`).test(path);
};

const packagePath = (path: string) => path === "package.json" ? "." : path.slice(0, -"/package.json".length);

function addManifestFacts(
  source: AxisProjectSource,
  manifest: Record<string, unknown>,
  rootManifest: Record<string, unknown> | null,
  workspacePatternsForPackages: ReadonlyArray<string>,
  facts: AxisOnboardingFact[],
): void {
  const manager = manifest.packageManager;
  if (typeof manager === "string" && manager.trim() !== "") facts.push(makeFact(source, "package-manager", manager));

  const engines = asRecord(manifest.engines);
  for (const [name, value] of Object.entries(engines ?? {})) {
    if (typeof value === "string") facts.push(makeFact(source, `engine.${name}`, value));
  }

  const currentPath = packagePath(source.path);
  const patterns = rootManifest === manifest ? workspacePatterns(manifest) : workspacePatternsForPackages;
  if (rootManifest === manifest && patterns.length > 0) {
    facts.push(makeFact(source, "workspace.type", "workspace"));
    facts.push(makeFact(source, "workspace.patterns", JSON.stringify(patterns)));
  } else if (rootManifest !== null && currentPath !== "." && patterns.some((pattern) => globMatches(pattern, currentPath))) {
    facts.push(makeFact(source, "workspace.type", "workspace-package"));
    facts.push(makeFact(source, "workspace.path", currentPath));
  } else if (currentPath === ".") {
    facts.push(makeFact(source, "workspace.type", "single-app"));
  }

  const scripts = asRecord(manifest.scripts);
  for (const name of relevantScripts) {
    const value = scripts?.[name];
    if (typeof value === "string") facts.push(makeFact(source, `script.${name}`, value));
  }
}

function parseManifest(source: AxisProjectSource): Record<string, unknown> {
  const parsed: unknown = JSON.parse(source.content ?? "");
  const manifest = asRecord(parsed);
  if (manifest === null) throw new Error("package.json must contain a JSON object.");
  return manifest;
}

export function deriveProjectFacts(
  inventory: AxisProjectSourcesResult,
  // @effect-diagnostics-next-line globalDate:off - the digest observation time is part of the result contract.
  observedAt = new Date().toISOString(),
): AxisProjectFactsResult {
  const digests: AxisOnboardingDigest[] = [];
  const facts: AxisOnboardingFact[] = [];
  const diagnostics: AxisProjectFactDiagnostic[] = [];
  const manifests = new Map<string, { source: AxisProjectSource; manifest: Record<string, unknown> }>();

  for (const source of inventory.sources) {
    if (source.status !== "read" || source.content === null) {
      if (source.status !== "read") diagnostics.push({ path: source.path, status: source.status, message: source.error ?? "Source is absent." });
      continue;
    }
    const value = source.content;
    digests.push({ id: digestId(source, value), sourceId: sourceId(source.path), algorithm: "sha256", value: digest(value), observedAt });
    if (
      source.truncated &&
      (source.path.endsWith("package.json") || source.path === "pnpm-workspace.yaml" || source.path === "pnpm-workspace.yml")
    ) {
      diagnostics.push({
        path: source.path,
        status: "invalid",
        message: "Manifest content was truncated; facts were not derived.",
      });
      continue;
    }
    if (source.path.endsWith("package.json")) {
      try {
        manifests.set(source.path, { source, manifest: parseManifest(source) });
      } catch (error) {
        diagnostics.push({ path: source.path, status: "invalid", message: error instanceof Error ? error.message : "Invalid package.json." });
      }
    }
  }

  const root = manifests.get("package.json")?.manifest ?? null;
  let workspacePatternsForPackages = root === null ? [] : workspacePatterns(root);

  for (const source of inventory.sources) {
    if (source.status !== "read" || source.content === null || !source.path.startsWith("pnpm-workspace.")) continue;
    try {
      const parsed = asRecord(parseYaml(source.content));
      const packages = stringList(parsed?.packages);
      if (packages === null) throw new Error("pnpm workspace packages must be an array.");
      workspacePatternsForPackages = packages;
      facts.push(makeFact(source, "workspace.type", "workspace"));
      facts.push(makeFact(source, "workspace.patterns", JSON.stringify(packages)));
    } catch (error) {
      diagnostics.push({ path: source.path, status: "invalid", message: error instanceof Error ? error.message : "Invalid pnpm workspace manifest." });
    }
  }

  for (const { source, manifest } of manifests.values()) {
    addManifestFacts(source, manifest, root, workspacePatternsForPackages, facts);
  }

  return { digests, facts, diagnostics };
}
