// @effect-diagnostics nodeBuiltinImport:off - synthetic filesystem fixtures use native symlinks.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { collectProjectSources } from "./AxisProjectSources.ts";

const withTempProject = async (run: (root: string, outside: string) => Promise<void>) => {
  const root = await NodeFSP.mkdtemp(
    NodePath.join(process.env.TMPDIR ?? "/tmp", "axis-project-sources-"),
  );
  const outside = await NodeFSP.mkdtemp(
    NodePath.join(process.env.TMPDIR ?? "/tmp", "axis-project-sources-outside-"),
  );
  try {
    await run(root, outside);
  } finally {
    await Promise.all([
      NodeFSP.rm(root, { recursive: true, force: true }),
      NodeFSP.rm(outside, { recursive: true, force: true }),
    ]);
  }
};

it("rejects a symlink that escapes the project root", async () => {
  await withTempProject(async (root, outside) => {
    await NodeFSP.writeFile(NodePath.join(outside, "AGENTS.md"), "private");
    await NodeFSP.symlink(NodePath.join(outside, "AGENTS.md"), NodePath.join(root, "AGENTS.md"));
    const result = await collectProjectSources(root);
    expect(result.sources).toContainEqual(
      expect.objectContaining({
        path: "AGENTS.md",
        status: "failed",
        error: "Symlink escapes the project root.",
      }),
    );
  });
});

it("reports a missing manifest as absent", async () => {
  await withTempProject(async (root) => {
    await NodeFSP.writeFile(NodePath.join(root, "AGENTS.md"), "Use TypeScript\n");
    const result = await collectProjectSources(root);
    expect(result.sources).toContainEqual(
      expect.objectContaining({ path: "package.json", status: "absent", content: null }),
    );
  });
});

it("does not inventory credential directories or credential-like file names", async () => {
  await withTempProject(async (root) => {
    await NodeFSP.mkdir(NodePath.join(root, "secrets"), { recursive: true });
    await NodeFSP.mkdir(NodePath.join(root, "config"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(root, "secrets", "config.md"), "private");
    await NodeFSP.writeFile(NodePath.join(root, "config", "api-keys.txt"), "private");
    await NodeFSP.writeFile(NodePath.join(root, ".editorconfig"), "root = true\n");
    const result = await collectProjectSources(root);
    const paths = result.sources.map((source) => source.path);
    expect(paths).not.toContain("secrets/config.md");
    expect(paths).not.toContain("config/api-keys.txt");
    expect(paths).toContain(".editorconfig");
  });
});

it("filters an internal symlink whose canonical target looks like a credential", async () => {
  await withTempProject(async (root) => {
    await NodeFSP.writeFile(NodePath.join(root, "api-token.md"), "private");
    await NodeFSP.symlink(NodePath.join(root, "api-token.md"), NodePath.join(root, "README.md"));
    const result = await collectProjectSources(root);
    expect(result.sources).toContainEqual(
      expect.objectContaining({
        path: "README.md",
        status: "failed",
        content: null,
        error: "Credential-like source was excluded.",
      }),
    );
  });
});

it("reports traversal truncation when the directory budget is exhausted", async () => {
  await withTempProject(async (root) => {
    await Promise.all(
      Array.from({ length: 260 }, (_, index) =>
        NodeFSP.mkdir(NodePath.join(root, `directory-${index}`)),
      ),
    );
    const result = await collectProjectSources(root);
    expect(result.truncated).toBe(true);
  });
});

it("limits the content of a large source and reports truncation", async () => {
  await withTempProject(async (root) => {
    await NodeFSP.writeFile(NodePath.join(root, "CLAUDE.md"), "x".repeat(20_000));
    const result = await collectProjectSources(root);
    const source = result.sources.find((candidate) => candidate.path === "CLAUDE.md");
    expect(source).toMatchObject({ status: "read", byteLength: 20_000, truncated: true });
    expect(source?.content).toHaveLength(8_000);
  });
});

it("preserves complete manifests above the prose limit and bounds oversized manifests", async () => {
  await withTempProject(async (root) => {
    const manifest = { scripts: { test: "vitest run" }, description: "x".repeat(9_000) };
    await NodeFSP.writeFile(NodePath.join(root, "package.json"), JSON.stringify(manifest));
    const result = await collectProjectSources(root);
    const source = result.sources.find((candidate) => candidate.path === "package.json");
    expect(source?.truncated).toBe(false);
    expect(JSON.parse(source!.content!)).toEqual(manifest);

    await NodeFSP.writeFile(NodePath.join(root, "package.json"), "x".repeat(40_000));
    const oversized = await collectProjectSources(root);
    const bounded = oversized.sources.find((candidate) => candidate.path === "package.json");
    expect(bounded?.truncated).toBe(true);
    expect(bounded?.content).toHaveLength(32_000);
  });
});
