import { describe, expect, it } from "vite-plus/test";

import { isProjectOverviewView, parseProjectOverviewSearch } from "./projectOverviewRoute";

describe("project overview route", () => {
  it("defaults invalid views to overview at the route boundary", () => {
    expect(isProjectOverviewView("workflow")).toBe(true);
    expect(isProjectOverviewView("unknown")).toBe(false);
    expect(
      parseProjectOverviewSearch({ view: "unknown", environmentId: " ", projectId: 3 }),
    ).toEqual({});
  });

  it("keeps a valid view and explicit physical member selection", () => {
    expect(
      parseProjectOverviewSearch({ view: "patterns", environmentId: "remote", projectId: "site" }),
    ).toEqual({ view: "patterns", environmentId: "remote", projectId: "site" });
  });
});
