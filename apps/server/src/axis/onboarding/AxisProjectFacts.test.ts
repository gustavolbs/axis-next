import { expect, it } from "@effect/vitest";

import { deriveProjectFacts } from "./AxisProjectFacts.ts";
import type { AxisProjectSourcesResult } from "./AxisProjectSources.ts";

const inventory = (
  ...sources: Array<Partial<AxisProjectSourcesResult["sources"][number]> & { path: string }>
): AxisProjectSourcesResult => ({
  workspaceRoot: "/project",
  sources: sources.map((source) => ({
    path: source.path,
    kind: source.kind ?? "manifest",
    status: source.status ?? "read",
    content: source.content ?? null,
    byteLength: source.byteLength ?? source.content?.length ?? 0,
    truncated: source.truncated ?? false,
    error: source.error ?? null,
  })),
  fileCount: sources.length,
  byteCount: sources.reduce((total, source) => total + (source.content?.length ?? 0), 0),
  truncated: false,
});

it("finds workspace and package-local scripts with independent test facts", () => {
  const result = deriveProjectFacts(
    inventory(
      {
        path: "package.json",
        content: JSON.stringify({
          packageManager: "pnpm@9",
          workspaces: ["apps/*"],
          scripts: { test: "pnpm test", "test:coverage": "pnpm coverage" },
        }),
      },
      {
        path: "apps/web/package.json",
        content: JSON.stringify({ scripts: { test: "vitest", lint: "eslint ." } }),
      },
    ),
    "2026-09-09T00:00:00.000Z",
  );
  expect(result.digests).toHaveLength(2);
  expect(result.facts.map((fact) => [fact.key, fact.value])).toEqual(
    expect.arrayContaining([
      ["package-manager", "pnpm@9"],
      ["workspace.type", "workspace"],
      ["workspace.type", "workspace-package"],
      ["script.test", "pnpm test"],
      ["script.test:coverage", "pnpm coverage"],
      ["script.test", "vitest"],
    ]),
  );
  const coverageFact = result.facts.find((fact) => fact.key === "script.test:coverage");
  expect(coverageFact?.sourceId).toBe(result.digests[0]?.sourceId);
});

it("reports invalid manifests instead of treating them as absent", () => {
  const result = deriveProjectFacts(inventory({ path: "package.json", content: "{ invalid" }));
  expect(result.facts).toEqual([]);
  expect(result.diagnostics).toEqual([
    expect.objectContaining({ path: "package.json", status: "invalid" }),
  ]);
  expect(result.digests).toHaveLength(1);
});

it("uses pnpm workspace patterns for package-local facts", () => {
  const result = deriveProjectFacts(
    inventory(
      { path: "package.json", content: JSON.stringify({ scripts: { test: "pnpm test" } }) },
      { path: "pnpm-workspace.yaml", kind: "manifest", content: "packages:\n  - apps/*\n" },
      { path: "apps/web/package.json", content: JSON.stringify({ scripts: { test: "vitest" } }) },
    ),
  );
  expect(result.facts).toEqual(
    expect.arrayContaining(
      [["workspace.type", "workspace-package"]].map(([key, value]) =>
        expect.objectContaining({ key, value }),
      ),
    ),
  );
});

it("does not derive facts from truncated manifests", () => {
  const result = deriveProjectFacts(
    inventory({
      path: "package.json",
      content: JSON.stringify({ packageManager: "pnpm@9", scripts: { test: "pnpm test" } }),
      truncated: true,
    }),
  );
  expect(result.facts).toEqual([]);
  expect(result.digests).toHaveLength(1);
  expect(result.diagnostics).toEqual([
    expect.objectContaining({ path: "package.json", status: "invalid" }),
  ]);
});

it("keeps absent and failed sources distinct and does not invent a test framework", () => {
  const result = deriveProjectFacts(
    inventory(
      { path: "package.json", status: "absent" },
      { path: "pnpm-workspace.yaml", status: "failed", error: "Permission denied" },
    ),
  );
  expect(result.facts).toEqual([]);
  expect(result.diagnostics).toEqual([
    { path: "package.json", status: "absent", message: "Source is absent." },
    { path: "pnpm-workspace.yaml", status: "failed", message: "Permission denied" },
  ]);
});
