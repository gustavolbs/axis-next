/**
 * The Axis settings map, owned by Axis.
 *
 * T3's settings sidebar and search index need to know these screens exist.
 * Declaring them here — rather than inline in those upstream files — keeps the
 * fork's footprint in each to a single import and a single spread, so an
 * upstream change to either file rarely conflicts with an Axis change to this
 * one. Adding or renaming an Axis screen touches no upstream file at all.
 *
 * @module features/axis/settings/axisSettingsNav
 */

import {
  BotIcon,
  BrainCircuitIcon,
  FolderKanbanIcon,
  PanelsTopLeftIcon,
  ShieldCheckIcon,
  SparklesIcon,
} from "lucide-react";

export const AXIS_SETTINGS_SECTIONS = [
  "contexts",
  "projects",
  "providers",
  "capabilities",
  "grants",
  "learning",
] as const;

export type AxisSettingsSection = (typeof AXIS_SETTINGS_SECTIONS)[number];

export const DEFAULT_AXIS_SETTINGS_SECTION: AxisSettingsSection = "contexts";

export function isAxisSettingsSection(value: unknown): value is AxisSettingsSection {
  return (
    typeof value === "string" && (AXIS_SETTINGS_SECTIONS as ReadonlyArray<string>).includes(value)
  );
}

export interface AxisSettingsScreen {
  readonly section: AxisSettingsSection;
  readonly label: string;
  /** Sentence shown under the title; also the search snippet. */
  readonly description: string;
  /** Extra search terms that are not in the label or description. */
  readonly keywords: ReadonlyArray<string>;
}

/**
 * One entry per screen. Order is the sidebar order, and it follows the order
 * a user has to do things in: contexts exist before Projects and providers
 * can be assigned to them, and a grant needs both ends to already exist.
 */
export const AXIS_SETTINGS_SCREENS: ReadonlyArray<AxisSettingsScreen> = [
  {
    section: "contexts",
    label: "Contexts",
    description: "Each Company is an isolated work and data context.",
    keywords: ["axis", "context", "company", "personal", "isolation"],
  },
  {
    section: "projects",
    label: "Projects",
    description: "Assign each Project to Personal or one Company.",
    keywords: ["axis", "project", "context", "assign", "scheduled"],
  },
  {
    section: "providers",
    label: "Providers",
    description: "Assign every provider account to Personal or one Company.",
    keywords: ["axis", "provider", "owner", "account", "company"],
  },
  {
    section: "capabilities",
    label: "Capabilities",
    description: "MCPs and skills Axis has adopted from each provider.",
    keywords: ["axis", "mcp", "skill", "capability", "instructions", "preferences"],
  },
  {
    section: "grants",
    label: "Access grants",
    description: "Let one Company use a provider owned by Personal.",
    keywords: ["axis", "grant", "access", "share", "provider", "company"],
  },
  {
    section: "learning",
    label: "Learning",
    description: "What Axis has learned about how you work.",
    keywords: ["axis", "learning", "hermes", "memory", "suggestion"],
  },
];

/**
 * Sidebar sub-items. `search` switches the visible screen; `targetId` stays a
 * stable anchor id so search results and deep links keep working.
 */
export const AXIS_SETTINGS_SIDEBAR_SECTIONS: ReadonlyArray<{
  readonly label: string;
  readonly targetId: string;
  readonly search: Readonly<Record<string, string>>;
  readonly icon: typeof PanelsTopLeftIcon;
}> = AXIS_SETTINGS_SCREENS.map((screen) => ({
  label: screen.label,
  targetId: `axis-${screen.section}`,
  search: { section: screen.section },
  icon: {
    contexts: PanelsTopLeftIcon,
    projects: FolderKanbanIcon,
    providers: BotIcon,
    capabilities: SparklesIcon,
    grants: ShieldCheckIcon,
    learning: BrainCircuitIcon,
  }[screen.section],
}));

/**
 * Search index rows. One per screen, so searching "grant" lands on the grants
 * screen rather than on a long page the reader then has to scan.
 */
export const AXIS_SETTINGS_SEARCH_ITEMS: ReadonlyArray<{
  readonly id: string;
  readonly title: string;
  readonly to: "/settings/axis";
  readonly searchTerms: ReadonlyArray<string>;
}> = AXIS_SETTINGS_SCREENS.map((screen) => ({
  id: `axis-${screen.section}`,
  title: screen.label,
  to: "/settings/axis" as const,
  searchTerms: [`${screen.description} ${screen.keywords.join(" ")}`],
}));
