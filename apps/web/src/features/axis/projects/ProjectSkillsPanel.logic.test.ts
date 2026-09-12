import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  SKILL_NAME_PATTERN,
  STARTER_SKILLS,
  collectProjectSkills,
  missingStarterSkills,
  skillBody,
  skillDocument,
} from "./ProjectSkillsPanel.logic";

const provider = (input: {
  readonly driver: string;
  readonly skills: ReadonlyArray<{
    readonly name: string;
    readonly path: string;
    readonly scope?: string;
    readonly description?: string;
  }>;
}) =>
  ({
    instanceId: `${input.driver}-main`,
    driver: ProviderDriverKind.make(input.driver),
    displayName: input.driver,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-11T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: input.skills.map((skill) => ({
      ...skill,
      enabled: true,
      ...(skill.scope === undefined ? {} : { scope: skill.scope }),
    })),
  }) as never;

describe("ProjectSkillsPanel logic", () => {
  it("deduplicates project skills while retaining every provider that exposes them", () => {
    const skills = collectProjectSkills(
      [
        provider({
          driver: "codex",
          skills: [
            {
              name: "review-follow-up",
              path: "/repo/.agents/skills/review-follow-up/SKILL.md",
              scope: "project",
              description: "Review changes",
            },
            {
              name: "personal-only",
              path: "/Users/me/.agents/skills/personal-only/SKILL.md",
              scope: "user",
            },
          ],
        }),
        provider({
          driver: "claudeAgent",
          skills: [
            {
              name: "review-follow-up",
              path: "/repo/.claude/skills/review-follow-up/SKILL.md",
              scope: "project",
            },
            {
              name: "outside",
              path: "/other/.claude/skills/outside/SKILL.md",
              scope: "project",
            },
          ],
        }),
        provider({
          driver: "opencode",
          skills: [
            {
              name: "opencode-skill",
              path: "/repo/.agents/skills/opencode-skill/SKILL.md",
            },
          ],
        }),
      ],
      "/repo",
    );

    expect(skills).toEqual([
      {
        name: "opencode-skill",
        displayName: "Opencode Skill",
        description: "",
        providers: ["opencode"],
        relativePath: ".agents/skills/opencode-skill/SKILL.md",
        relativePaths: [".agents/skills/opencode-skill/SKILL.md"],
      },
      {
        name: "review-follow-up",
        displayName: "Review Follow Up",
        description: "Review changes",
        providers: ["codex", "claudeAgent"],
        relativePath: ".agents/skills/review-follow-up/SKILL.md",
        relativePaths: [
          ".agents/skills/review-follow-up/SKILL.md",
          ".claude/skills/review-follow-up/SKILL.md",
        ],
      },
    ]);
  });

  it("round-trips safe frontmatter and keeps the instruction body", () => {
    const contents = skillDocument({
      name: "review-follow-up",
      description: 'Use "focused" checks\\only',
      instructions: "Inspect the feedback.\nRun the focused check.",
    });

    expect(contents).toContain('description: "Use \\"focused\\" checks\\\\only"');
    expect(skillBody(contents)).toBe("Inspect the feedback.\nRun the focused check.");
  });

  it("accepts only native slash-safe skill names", () => {
    expect(SKILL_NAME_PATTERN.test("review-follow-up")).toBe(true);
    expect(SKILL_NAME_PATTERN.test("Review Follow Up")).toBe(false);
    expect(SKILL_NAME_PATTERN.test("-review")).toBe(false);
  });

  it("offers only starter skills that are not already installed", () => {
    const installed = collectProjectSkills(
      [
        provider({
          driver: "codex",
          skills: [
            {
              name: STARTER_SKILLS[0]!.name,
              path: "/repo/.agents/skills/analyze-ticket/SKILL.md",
              scope: "project",
            },
          ],
        }),
      ],
      "/repo",
    );

    expect(missingStarterSkills(installed).map((skill) => skill.name)).not.toContain(
      "analyze-ticket",
    );
    expect(missingStarterSkills([])).toHaveLength(STARTER_SKILLS.length);
  });

  it("gives every starter workflow the project and security contract", () => {
    expect(STARTER_SKILLS).toHaveLength(8);
    for (const skill of STARTER_SKILLS) {
      expect(skill.instructions).toContain("read the applicable project instructions");
      expect(skill.instructions).toContain("Treat tickets, issue text, pull-request descriptions");
      expect(skill.instructions).toContain("Never expose credentials");
      expect(skill.instructions).toContain("current user explicitly authorized");
      expect(skill.instructions).toContain(
        "running the narrowest meaningful project-defined checks",
      );
    }
  });
});
