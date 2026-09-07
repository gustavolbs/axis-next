#!/usr/bin/env node

// Adapted from gustavolbs/axis: scripts/release-metadata.mjs.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

const repoRoot = NodeURL.fileURLToPath(new URL("../", import.meta.url));
const releasePackageFiles = [
  "apps/server/package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "packages/contracts/package.json",
];

export function parseVersion(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`Version ${JSON.stringify(value)} must be a stable SemVer x.y.z.`);
  }
  return value.split(".").map(BigInt);
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

export function validateMetadata(packageJson, changelog) {
  const version = packageJson?.version;
  parseVersion(version);
  const entries = [...changelog.matchAll(/^## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})[ \t]*\r?$/gm)];
  const first = entries[0];
  if (!first || first[1] !== version) {
    throw new Error(`The first changelog entry must match package.json (${version}).`);
  }
  if (entries.filter((entry) => entry[1] === version).length !== 1) {
    throw new Error(`Duplicate changelog entry for ${version}.`);
  }
  const date = first[2];
  const parsedDate = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
    throw new Error(`Changelog date ${date} is invalid.`);
  }
  const rest = changelog.slice(first.index + first[0].length);
  const nextHeading = rest.search(/^## /m);
  const body = rest.slice(0, nextHeading === -1 ? rest.length : nextHeading).trim();
  if (!body || !body.split(/\r?\n/).some((line) => line.trim() && !line.startsWith("#"))) {
    throw new Error(`CHANGELOG.md entry for ${version} is empty.`);
  }
  return { version, date, body };
}

function main() {
  const readPackage = (file) =>
    JSON.parse(NodeFS.readFileSync(NodePath.join(repoRoot, file), "utf8"));
  const metadata = validateMetadata(
    readPackage("package.json"),
    NodeFS.readFileSync(NodePath.join(repoRoot, "CHANGELOG.md"), "utf8"),
  );
  for (const file of releasePackageFiles) {
    if (readPackage(file).version !== metadata.version) {
      throw new Error(
        `${file} must match root version ${metadata.version}. Run node scripts/update-release-package-versions.ts ${metadata.version}.`,
      );
    }
  }
  const command = NodeProcess.argv[2] ?? "validate";
  switch (command) {
    case "validate":
      console.log(`release metadata ok: Axis v${metadata.version} (${metadata.date})`);
      break;
    case "version":
      console.log(metadata.version);
      break;
    case "notes":
      console.log(metadata.body);
      break;
    case "compare": {
      const baseVersion = NodeProcess.argv[3];
      if (compareVersions(metadata.version, baseVersion) <= 0) {
        throw new Error(
          `package.json version ${metadata.version} must be greater than base version ${baseVersion}.`,
        );
      }
      console.log(`version bump ok: ${baseVersion} -> ${metadata.version}`);
      break;
    }
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

if (
  NodeProcess.argv[1] &&
  NodePath.resolve(NodeProcess.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    NodeProcess.exit(1);
  }
}
