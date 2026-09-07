import { describe, expect, it } from "vite-plus/test";
import { compareVersions, parseVersion, validateMetadata } from "./release-metadata.mjs";

const entry = (version, body = "### Fixed\n\n- Fix updates.", date = "2026-09-07") =>
  `## [${version}] - ${date}\n\n${body}\n`;

describe("Axis release metadata", () => {
  it("extracts only the current release notes", () => {
    expect(
      validateMetadata(
        { version: "0.0.39" },
        `# Changelog\n\n${entry("0.0.39")}\n${entry("0.0.38")}`,
      ),
    ).toEqual({ version: "0.0.39", date: "2026-09-07", body: "### Fixed\n\n- Fix updates." });
  });

  it.each([undefined, "01.0.0", "1.0", "v1.0.0", "1.0.0-beta.1", "1.0.0+build"])(
    "rejects non-stable or malformed version %s",
    (version) => expect(() => parseVersion(version)).toThrow("stable SemVer"),
  );

  it("compares versions numerically, including large components", () => {
    expect(compareVersions("0.0.10", "0.0.9")).toBe(1);
    expect(compareVersions("1.0.0", "0.99.99")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.9.0", "1.10.0")).toBe(-1);
    expect(compareVersions("1.0.9007199254740993", "1.0.9007199254740992")).toBe(1);
  });

  it("requires the current version first and exactly once", () => {
    expect(() => validateMetadata({ version: "1.0.1" }, entry("1.0.0") + entry("1.0.1"))).toThrow(
      "first",
    );
    expect(() => validateMetadata({ version: "1.0.0" }, entry("1.0.0") + entry("1.0.0"))).toThrow(
      "Duplicate",
    );
  });

  it.each(["", "### Fixed", "\n\n"])("rejects empty notes %s", (body) => {
    expect(() =>
      validateMetadata({ version: "1.0.0" }, entry("1.0.0", body) + entry("0.9.0")),
    ).toThrow("empty");
  });

  it.each(["2026-02-30", "2026-13-01", "2025-02-29"])("rejects invalid date %s", (date) => {
    expect(() => validateMetadata({ version: "1.0.0" }, entry("1.0.0", "- Fix.", date))).toThrow(
      "invalid",
    );
  });

  it("accepts leap days and Windows line endings", () => {
    expect(
      validateMetadata(
        { version: "1.0.0" },
        entry("1.0.0", "- Fix.", "2024-02-29").replaceAll("\n", "\r\n"),
      ).date,
    ).toBe("2024-02-29");
  });
});
