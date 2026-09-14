import type { ServerProviderSkill } from "@t3tools/contracts";
import { formatProviderSkillDisplayName } from "@t3tools/client-runtime/providerSkills";

import {
  CHAT_INLINE_CHIP_CLASS_NAME,
  CHAT_INLINE_CHIP_LABEL_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  SKILL_CHIP_ICON_SVG,
} from "../composerInlineChip";
import { cn } from "~/lib/utils";

type InlineSkill = Pick<ServerProviderSkill, "name" | "displayName">;

interface SkillInjectionChipsProps {
  readonly names: ReadonlyArray<string>;
  readonly skills: ReadonlyArray<InlineSkill>;
}

/**
 * Renders the chip row that confirms which Axis project skills the server
 * actually injected into the agent's prompt for this turn. Resolves each
 * $name against the project skill catalog so the chip shows the display name
 * (e.g. "Taste-Skill" rather than the kebab-case slug).
 */
export function SkillInjectionChips({ names, skills }: SkillInjectionChipsProps) {
  if (names.length === 0) return null;
  const skillsByName = new Map(skills.map((skill) => [skill.name, skill]));
  const resolved = names.map((name) => ({
    name,
    skill: skillsByName.get(name),
  }));

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1" data-testid="skill-injection-chips">
      {resolved.map(({ name, skill }) => (
        <span
          key={name}
          className="inline-flex items-center leading-none"
          data-markdown-copy={`$${name}`}
        >
          <span
            className={cn(
              CHAT_INLINE_CHIP_CLASS_NAME,
              "border-fuchsia-500/25 bg-fuchsia-500/12 text-fuchsia-700 dark:text-fuchsia-300",
            )}
          >
            <span
              aria-hidden="true"
              className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME}
              dangerouslySetInnerHTML={{ __html: SKILL_CHIP_ICON_SVG }}
            />
            <span className={CHAT_INLINE_CHIP_LABEL_CLASS_NAME}>
              {skill ? formatProviderSkillDisplayName(skill) : `$${name}`}
            </span>
          </span>
        </span>
      ))}
    </div>
  );
}
