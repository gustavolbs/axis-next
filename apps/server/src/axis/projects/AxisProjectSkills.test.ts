// @effect-diagnostics nodeBuiltinImport:off - symlink setup is a filesystem security test.
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";

import {
  AXIS_PROJECT_SKILL_MAX_BYTES,
  axisProjectSkillNamesInPrompt,
  discoverAxisProjectSkills,
  formatAxisProjectSkillCatalog,
  formatAxisProjectSkillInstructions,
  readAxisProjectSkill,
} from "./AxisProjectSkills.ts";

const withNodeServices = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
) => effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("AxisProjectSkills", () => {
  it.effect("discovers only local, bounded skills and rejects escaping symlinks", () =>
    withNodeServices(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-axis-project-skills-",
        });
        const outsideRoot = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-axis-project-skills-outside-",
        });
        const skillsRoot = path.join(workspaceRoot, ".axis-tools", "skills");
        const localSkill = path.join(skillsRoot, "review-follow-up", "SKILL.md");
        const escapedSkillDirectory = path.join(skillsRoot, "escaped");
        const oversizedSkill = path.join(skillsRoot, "too-large", "SKILL.md");

        yield* fileSystem.makeDirectory(path.dirname(localSkill), { recursive: true });
        yield* fileSystem.makeDirectory(path.dirname(oversizedSkill), { recursive: true });
        yield* fileSystem.makeDirectory(outsideRoot, { recursive: true });
        yield* fileSystem.writeFileString(
          localSkill,
          "---\ndescription: Review changes safely\ndisplayName: Review follow-up\n---\n\nInspect the feedback and run focused checks.\n",
        );
        yield* fileSystem.writeFileString(
          path.join(outsideRoot, "SKILL.md"),
          "---\ndescription: secret\n---\n\nNever expose this.\n",
        );
        yield* fileSystem.writeFileString(
          oversizedSkill,
          "x".repeat(AXIS_PROJECT_SKILL_MAX_BYTES + 1),
        );
        NodeFS.symlinkSync(outsideRoot, escapedSkillDirectory, "dir");
        const realLocalSkill = yield* fileSystem.realPath(localSkill);

        const skills = yield* discoverAxisProjectSkills(workspaceRoot);

        expect(skills).toEqual([
          {
            name: "review-follow-up",
            description: "Review changes safely",
            displayName: "Review follow-up",
            path: realLocalSkill,
            contents: "Inspect the feedback and run focused checks.",
          },
        ]);
        expect(yield* readAxisProjectSkill({ workspaceRoot, name: "escaped" })).toBeUndefined();
        expect(yield* readAxisProjectSkill({ workspaceRoot, name: "../escaped" })).toBeUndefined();
      }),
    ),
  );

  it("extracts explicit skill mentions without trusting arbitrary paths", () => {
    expect(axisProjectSkillNamesInPrompt("Use $review-follow-up, then $REVIEW-follow-up.")).toEqual(
      ["review-follow-up"],
    );
    expect(axisProjectSkillNamesInPrompt("cost is 5$review-follow-up")).toEqual([]);
  });

  it("keeps selected skill instructions bounded and provider-neutral", () => {
    const formatted = formatAxisProjectSkillInstructions([
      {
        name: "review-follow-up",
        contents: "Inspect the feedback.",
      },
    ]);

    expect(formatted).toContain("$review-follow-up");
    expect(formatted).toContain("Inspect the feedback.");
    expect(formatted).not.toContain("/repo/.axis-tools");
    expect(formatted).not.toContain("/skill:");
  });

  it("renders an empty catalog when no skills are available", () => {
    expect(formatAxisProjectSkillCatalog([])).toBe("");
  });

  it("renders an inference-friendly catalog with name, description, and path", () => {
    const formatted = formatAxisProjectSkillCatalog([
      {
        name: "taste-skill",
        description: "Anti-slop frontend design rules.",
        path: "/repo/.axis-tools/skills/taste-skill/SKILL.md",
      },
      {
        name: "impeccable",
        description: "Design guidance.",
        displayName: "Impeccable",
        path: "/repo/.axis-tools/skills/impeccable/SKILL.md",
      },
    ]);

    expect(formatted).toContain("## Axis project skills available");
    expect(formatted).toContain("read");
    expect(formatted).toContain("$taste-skill");
    expect(formatted).toContain("Anti-slop frontend design rules.");
    expect(formatted).toContain("$impeccable (Impeccable)");
    expect(formatted).toContain("/repo/.axis-tools/skills/taste-skill/SKILL.md");
  });

  it("falls back to a placeholder description when a skill has none", () => {
    const formatted = formatAxisProjectSkillCatalog([
      { name: "no-description", path: "/x/.axis-tools/skills/no-description/SKILL.md" },
    ]);
    expect(formatted).toContain("(no description)");
  });

  it.effect("discovers multiple skills so the turn-start event has names to surface", () =>
    withNodeServices(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-axis-project-skill-injection-",
        });
        const skillsRoot = path.join(workspaceRoot, ".axis-tools", "skills");
        yield* fileSystem.makeDirectory(path.join(skillsRoot, "design-taste-frontend"), {
          recursive: true,
        });
        yield* fileSystem.makeDirectory(path.join(skillsRoot, "impeccable"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          path.join(skillsRoot, "design-taste-frontend", "SKILL.md"),
          "---\ndescription: Anti-slop frontend rules\n---\n\nFollow the rules.\n",
        );
        yield* fileSystem.writeFileString(
          path.join(skillsRoot, "impeccable", "SKILL.md"),
          "---\ndescription: Design guidance\n---\n\nPolish before shipping.\n",
        );

        const skills = yield* discoverAxisProjectSkills(workspaceRoot);
        const names = skills.map((skill) => skill.name).sort();
        expect(names).toEqual(["design-taste-frontend", "impeccable"]);
        // Each skill carries enough context for the client to render a chip
        // without a follow-up lookup: name, description, and path.
        for (const skill of skills) {
          expect(skill.path.length).toBeGreaterThan(0);
          expect(skill.description.length).toBeGreaterThan(0);
        }
      }),
    ),
  );
});
