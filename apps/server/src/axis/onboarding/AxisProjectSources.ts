// @effect-diagnostics nodeBuiltinImport:off - bounded reads need lstat, realpath, and open.
import type * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as AxisProjectScope from "../projects/AxisProjectScope.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";

export const AXIS_PROJECT_SOURCES_MAX_FILES = 200;
export const AXIS_PROJECT_SOURCE_MAX_BYTES = 8_000;
export const AXIS_PROJECT_SOURCES_MAX_BYTES = 256_000;
export const AXIS_PROJECT_SOURCES_MAX_DIRECTORIES = 256;
export const AXIS_PROJECT_SOURCES_MAX_ENTRIES = 4_000;

const excludedDirectories = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", ".cache", "coverage"]);
const instructionNames = new Set(["AGENTS.md", "CLAUDE.md"]);
const manifestNames = new Set([
  "package.json", "pnpm-workspace.yaml", "pnpm-workspace.yml", "turbo.json", "lerna.json",
  "Cargo.toml", "pyproject.toml", "go.mod", "pom.xml", "build.gradle", "Makefile",
]);
const conventionNames = new Set(["CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "README.md", ".editorconfig"]);
const credentialPattern = /(^|[._-])(env|secret|secrets|token|tokens|password|passwords|credential|credentials|key|keys|api[-_]?keys?)([._-]|$)/i;
const templatePattern = /(^|\/)(templates?|issue_template|pull_request_template)(\/|\.|$)/i;
const ciPattern = /(^|\/)\.github\/workflows\/[^/]+\.(ya?ml)$/i;

export type AxisProjectSourceKind = "manifest" | "instruction" | "ci" | "template" | "convention";
export type AxisProjectSourceStatus = "read" | "absent" | "failed";

export interface AxisProjectSource {
  readonly path: string;
  readonly kind: AxisProjectSourceKind;
  readonly status: AxisProjectSourceStatus;
  readonly content: string | null;
  readonly byteLength: number;
  readonly truncated: boolean;
  readonly error: string | null;
}

export interface AxisProjectSourcesResult {
  readonly workspaceRoot: string;
  readonly sources: ReadonlyArray<AxisProjectSource>;
  readonly fileCount: number;
  readonly byteCount: number;
  readonly truncated: boolean;
}

export class AxisProjectSourcesError extends Schema.TaggedErrorClass<AxisProjectSourcesError>()(
  "AxisProjectSourcesError",
  {
    reason: Schema.Literals(["project_not_found", "root_inaccessible"]),
    message: Schema.String,
  },
) {}

type Candidate = { readonly path: string; readonly kind: AxisProjectSourceKind };
const requiredRootSources: ReadonlyArray<Candidate> = [
  ...[...instructionNames].map((path) => ({ path, kind: "instruction" as const })),
  ...[...manifestNames].map((path) => ({ path, kind: "manifest" as const })),
];

function isInside(root: string, target: string): boolean {
  const relative = NodePath.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${NodePath.sep}`) && !NodePath.isAbsolute(relative);
}

function classify(relativePath: string): AxisProjectSourceKind | null {
  const name = NodePath.basename(relativePath);
  if (instructionNames.has(name)) return "instruction";
  if (manifestNames.has(name)) return "manifest";
  if (ciPattern.test(relativePath)) return "ci";
  if (templatePattern.test(relativePath) || /template/i.test(name)) return "template";
  if (conventionNames.has(name)) return "convention";
  return null;
}

function isCredentialPath(relativePath: string): boolean {
  return relativePath.split("/").some((segment) => {
    if (segment === ".editorconfig") return false;
    return credentialPattern.test(segment);
  });
}

function diagnostic(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message.slice(0, 2_000);
  return "The source could not be read.";
}

async function discover(root: string): Promise<{
  readonly candidates: ReadonlyArray<Candidate>;
  readonly truncated: boolean;
}> {
  const candidates: Candidate[] = [];
  const pending: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  let directoryCount = 1;
  let entryCount = 0;
  let truncated = false;
  while (pending.length > 0 && candidates.length < AXIS_PROJECT_SOURCES_MAX_FILES) {
    const current = pending.pop()!;
    let entries: NodeFS.Dirent[];
    try {
      entries = await NodeFSP.readdir(current.path, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      entryCount += 1;
      if (entryCount > AXIS_PROJECT_SOURCES_MAX_ENTRIES) {
        truncated = true;
        break;
      }
      if (candidates.length >= AXIS_PROJECT_SOURCES_MAX_FILES) break;
      if (entry.name.startsWith(".") && entry.name !== ".github" && entry.name !== ".editorconfig") continue;
      const relativePath = NodePath.relative(root, NodePath.join(current.path, entry.name)).split(NodePath.sep).join("/");
      if (isCredentialPath(relativePath)) continue;
      if (entry.isDirectory()) {
        if (current.depth < 4 && !excludedDirectories.has(entry.name)) {
          if (directoryCount >= AXIS_PROJECT_SOURCES_MAX_DIRECTORIES) {
            truncated = true;
            break;
          }
          directoryCount += 1;
          pending.push({ path: NodePath.join(current.path, entry.name), depth: current.depth + 1 });
        }
        continue;
      }
      const kind = classify(relativePath);
      if (kind !== null) candidates.push({ path: relativePath, kind });
    }
    if (entryCount >= AXIS_PROJECT_SOURCES_MAX_ENTRIES) truncated = true;
    if (truncated) break;
  }
  if (candidates.length >= AXIS_PROJECT_SOURCES_MAX_FILES) truncated = true;
  if (pending.length > 0) truncated = true;
  const discoveredPaths = new Set(candidates.map((candidate) => candidate.path));
  for (const candidate of requiredRootSources) {
    if (!discoveredPaths.has(candidate.path)) candidates.push(candidate);
  }
  return {
    candidates: candidates
      .toSorted((a, b) => a.path.localeCompare(b.path))
      .slice(0, AXIS_PROJECT_SOURCES_MAX_FILES),
    truncated,
  };
}

async function readCandidate(root: string, candidate: Candidate, remaining: { bytes: number }): Promise<AxisProjectSource> {
  const absolutePath = NodePath.resolve(root, candidate.path);
  const base = { path: candidate.path, kind: candidate.kind };
  if (!isInside(root, absolutePath)) {
    return { ...base, status: "failed", content: null, byteLength: 0, truncated: false, error: "Path traversal is not allowed." };
  }
  try {
    const realPath = await NodeFSP.realpath(absolutePath);
    if (!isInside(root, realPath)) return { ...base, status: "failed", content: null, byteLength: 0, truncated: false, error: "Symlink escapes the project root." };
    const realRelativePath = NodePath.relative(root, realPath).split(NodePath.sep).join("/");
    if (isCredentialPath(realRelativePath)) return { ...base, status: "failed", content: null, byteLength: 0, truncated: false, error: "Credential-like source was excluded." };
    const stat = await NodeFSP.stat(realPath);
    if (!stat.isFile()) return { ...base, status: "failed", content: null, byteLength: 0, truncated: false, error: "Source is not a regular file." };
    const bytes = Math.min(stat.size, AXIS_PROJECT_SOURCE_MAX_BYTES, remaining.bytes);
    const handle = await NodeFSP.open(realPath, "r");
    let content: Uint8Array;
    try {
      const buffer = Buffer.alloc(bytes);
      const result = await handle.read(buffer, 0, bytes, 0);
      content = buffer.subarray(0, result.bytesRead);
    } finally {
      await handle.close();
    }
    const truncated = stat.size > bytes;
    remaining.bytes -= content.byteLength;
    return { ...base, status: "read", content: new TextDecoder().decode(content), byteLength: stat.size, truncated, error: null };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return { ...base, status: "absent", content: null, byteLength: 0, truncated: false, error: null };
    }
    return { ...base, status: "failed", content: null, byteLength: 0, truncated: false, error: diagnostic(error) };
  }
}

export async function collectProjectSources(workspaceRoot: string): Promise<AxisProjectSourcesResult> {
  const root = await NodeFSP.realpath(workspaceRoot);
  const rootStat = await NodeFSP.stat(root);
  if (!rootStat.isDirectory()) throw new Error("Project workspace root is not a directory.");
  const discovered = await discover(root);
  const candidates = discovered.candidates;
  const remaining = { bytes: AXIS_PROJECT_SOURCES_MAX_BYTES };
  const sources: AxisProjectSource[] = [];
  for (const candidate of candidates) sources.push(await readCandidate(root, candidate, remaining));
  const readBytes = sources.reduce((total, source) => total + (source.content === null ? 0 : new TextEncoder().encode(source.content).byteLength), 0);
  return {
    workspaceRoot: root,
    sources,
    fileCount: sources.length,
    byteCount: readBytes,
    truncated: sources.some((source) => source.truncated) || discovered.truncated,
  };
}

export class AxisProjectSources extends Context.Service<AxisProjectSources, {
  readonly collect: (scope: AxisProjectScope.AxisResolvedProjectScope) => Effect.Effect<AxisProjectSourcesResult, AxisProjectSourcesError>;
}>()("t3/axis/onboarding/AxisProjectSources") {}

export const make = Effect.gen(function* () {
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const collect = (scope: AxisProjectScope.AxisResolvedProjectScope) =>
    Effect.gen(function* () {
      const project = yield* projections.getProjectShellById(scope.scope.project.projectId).pipe(
        Effect.mapError(() => new AxisProjectSourcesError({ reason: "project_not_found", message: "The Project could not be read." })),
      );
      if (project._tag === "None") return yield* new AxisProjectSourcesError({ reason: "project_not_found", message: "The Project does not exist." });
      return yield* Effect.tryPromise({ try: () => collectProjectSources(project.value.workspaceRoot), catch: (error) => new AxisProjectSourcesError({ reason: "root_inaccessible", message: diagnostic(error) }) });
    });
  return { collect } satisfies AxisProjectSources["Service"];
});

export const layer = Layer.effect(AxisProjectSources, make);
