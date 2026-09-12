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
});
