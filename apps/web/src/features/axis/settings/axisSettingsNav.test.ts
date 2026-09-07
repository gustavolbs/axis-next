import { describe, expect, it } from "vite-plus/test";

import {
  AXIS_SETTINGS_SCREENS,
  AXIS_SETTINGS_SEARCH_ITEMS,
  AXIS_SETTINGS_SIDEBAR_SECTIONS,
  AXIS_SETTINGS_SECTIONS,
  DEFAULT_AXIS_SETTINGS_SECTION,
  isAxisSettingsSection,
} from "./axisSettingsNav";

describe("axis settings navigation", () => {
  // Every screen must be reachable. A screen that exists but is not in the
  // sidebar is exactly the bug this restructure fixed: three of the six
  // sections were previously unreachable from the nav.
  it("exposes every screen in the sidebar and in search", () => {
    const sections = AXIS_SETTINGS_SCREENS.map((screen) => screen.section);
    expect(sections).toEqual([...AXIS_SETTINGS_SECTIONS]);
    expect(AXIS_SETTINGS_SIDEBAR_SECTIONS.map((entry) => entry.search.section)).toEqual(sections);
    expect(AXIS_SETTINGS_SEARCH_ITEMS.map((item) => item.id)).toEqual(
      sections.map((section) => `axis-${section}`),
    );
  });

  it("validates the section search param, rejecting anything else", () => {
    for (const section of AXIS_SETTINGS_SECTIONS) {
      expect(isAxisSettingsSection(section)).toBe(true);
    }
    expect(isAxisSettingsSection("provider-access")).toBe(false);
    expect(isAxisSettingsSection(undefined)).toBe(false);
    expect(isAxisSettingsSection(2)).toBe(false);
  });

  it("defaults to a section that exists", () => {
    expect(isAxisSettingsSection(DEFAULT_AXIS_SETTINGS_SECTION)).toBe(true);
  });

  it("gives each search row terms beyond its title", () => {
    for (const item of AXIS_SETTINGS_SEARCH_ITEMS) {
      expect(item.searchTerms.join(" ").length).toBeGreaterThan(item.title.length);
    }
  });
});
