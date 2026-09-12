import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  AXIS_AGENTS_BLOCK_END,
  AXIS_AGENTS_BLOCK_START,
  SKILL_NAME_PATTERN,
  STARTER_SKILLS,
  collectProjectSkills,
  mergeAxisAgentsBlock,
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
              path: "/repo/.axis-tools/skills/review-follow-up/SKILL.md",
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
              path: "/repo/.axis-tools/skills/review-follow-up/SKILL.md",
              scope: "project",
            },
            {
              name: "outside",
              path: "/other/.axis-tools/skills/outside/SKILL.md",
              scope: "project",
            },
          ],
        }),
        provider({
          driver: "opencode",
          skills: [
            {
              name: "opencode-skill",
              path: "/repo/.axis-tools/skills/opencode-skill/SKILL.md",
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
        relativePath: ".axis-tools/skills/opencode-skill/SKILL.md",
        relativePaths: [".axis-tools/skills/opencode-skill/SKILL.md"],
      },
      {
        name: "review-follow-up",
        displayName: "Review Follow Up",
        description: "Review changes",
        providers: ["codex", "claudeAgent"],
        relativePath: ".axis-tools/skills/review-follow-up/SKILL.md",
        relativePaths: [".axis-tools/skills/review-follow-up/SKILL.md"],
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
              path: "/repo/.axis-tools/skills/analyze-ticket/SKILL.md",
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

  it("preserves user AGENTS content and replaces only its managed block", () => {
    const original = "# Project rules\n\nKeep the existing instructions.\n";
    const first = mergeAxisAgentsBlock(original);
    const second = mergeAxisAgentsBlock(`${first}\n\nUser edit\n`);

    expect(first).toContain(original.trim());
    expect(first).toContain(AXIS_AGENTS_BLOCK_START);
    expect(first).toContain(AXIS_AGENTS_BLOCK_END);
    expect(second).toContain("User edit");
    expect(second.match(new RegExp(AXIS_AGENTS_BLOCK_START, "g"))).toHaveLength(1);
    expect(second.match(new RegExp(AXIS_AGENTS_BLOCK_END, "g"))).toHaveLength(1);
  });
});
