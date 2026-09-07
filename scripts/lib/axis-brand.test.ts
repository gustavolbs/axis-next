import { assert, describe, it } from "@effect/vitest";

import {
  applyAxisDocumentTitle,
  AXIS_DESKTOP_APP_ID,
  resolveAxisProductName,
  resolveAxisWebIconOverrides,
} from "./axis-brand.ts";

describe("axis-brand", () => {
  it("keeps the Axis bundle identity separate from upstream T3 Code", () => {
    assert.notEqual(AXIS_DESKTOP_APP_ID, "com.t3tools.t3code");
  });

  it("names each release channel", () => {
    assert.equal(resolveAxisProductName("latest"), "Axis");
    assert.equal(resolveAxisProductName("nightly"), "Axis (Nightly)");
  });

  it("overrides exactly the favicon names the built client already serves", () => {
    const overrides = resolveAxisWebIconOverrides("apps/server/dist/client");

    assert.deepStrictEqual(
      overrides.map((override) => override.targetRelativePath),
      [
        "apps/server/dist/client/favicon.ico",
        "apps/server/dist/client/favicon-16x16.png",
        "apps/server/dist/client/favicon-32x32.png",
        "apps/server/dist/client/apple-touch-icon.png",
      ],
    );
  });

  it("rewrites the packaged client title", () => {
    assert.equal(
      applyAxisDocumentTitle("<head><title>T3 Code (Alpha)</title><meta /></head>", "Axis"),
      "<head><title>Axis</title><meta /></head>",
    );
  });

  it("leaves markup without a title untouched rather than corrupting it", () => {
    assert.equal(applyAxisDocumentTitle("<head><meta /></head>", "Axis"), "<head><meta /></head>");
  });
});
