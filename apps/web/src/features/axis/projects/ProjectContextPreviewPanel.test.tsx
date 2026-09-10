import type { ReactElement } from "react";
import {
  AxisContextId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type AxisContextProjectScope,
  type ModelSelection,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "~/test/reactElementTree";
import { reactHookHarness as hooks } from "~/test/reactHookHarness";

const setup = vi.hoisted(() => ({
  preview: vi.fn((input: unknown) => ({ input })),
  queryInputs: [] as unknown[],
  refresh: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("~/test/reactHookHarness");
  return {
    ...actual,
    useEffect: () => undefined,
    useMemo: reactHookHarness.useMemo,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("~/test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("~/state/server", () => ({
  serverEnvironment: { axisProjectContextPreview: setup.preview },
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (input: unknown) => {
    setup.queryInputs.push(input);
    return { data: null, error: null, isPending: false, refresh: setup.refresh };
  },
}));

import { ProjectContextPreviewPanel } from "./ProjectContextPreviewPanel";

const environmentId = EnvironmentId.make("environment");
const scope: AxisContextProjectScope = {
  contextId: AxisContextId.make("company"),
  project: { environmentId, projectId: ProjectId.make("project") },
};
const modelSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-test",
};

const renderPanel = () => {
  hooks.beginRender();
  return ProjectContextPreviewPanel({
    environmentId,
    scope,
    modelSelection,
    connectionState: "connected",
  });
};

const input = (view: ReactElement, label: string) => {
  const result = visitElements(view, (element) => element.props["aria-label"] === label);
  if (result === null) throw new Error(`Missing input: ${label}`);
  return result;
};

const changeInput = (view: ReactElement, label: string, value: string) => {
  const onChange = input(view, label).props.onChange;
  if (typeof onChange !== "function") throw new Error(`Input has no change handler: ${label}`);
  onChange({ target: { value } });
};

const refreshButton = (view: ReactElement) => {
  const result = visitElements(
    view,
    (element) =>
      typeof element.props.onClick === "function" &&
      Array.isArray(element.props.children) &&
      element.props.children.includes("Refresh"),
  );
  if (result === null) throw new Error("Missing Refresh button");
  return result;
};

const clickRefresh = (view: ReactElement) => {
  const onClick = refreshButton(view).props.onClick;
  if (typeof onClick !== "function") throw new Error("Refresh button has no click handler");
  onClick();
};

describe("Project context preview", () => {
  beforeEach(() => {
    hooks.reset();
    setup.preview.mockClear();
    setup.refresh.mockClear();
    setup.queryInputs.length = 0;
  });

  it("submits editable fields only on Refresh instead of querying on each keystroke", () => {
    let view = renderPanel();
    expect(setup.preview).not.toHaveBeenCalled();
    expect(setup.queryInputs.at(-1)).toBeNull();

    changeInput(view, "Preview step", "plan");
    view = renderPanel();
    expect(setup.preview).not.toHaveBeenCalled();

    clickRefresh(view);
    view = renderPanel();
    expect(setup.preview).toHaveBeenCalledTimes(1);
    expect(setup.preview.mock.calls[0]?.[0]).toMatchObject({
      environmentId,
      input: { scope, step: "plan", paths: [], model: "gpt-test" },
    });

    changeInput(view, "Preview paths", "src/a.ts");
    view = renderPanel();
    expect(setup.preview).toHaveBeenCalledTimes(1);
    expect(setup.queryInputs.at(-1)).toBeNull();

    clickRefresh(view);
    renderPanel();
    expect(setup.preview).toHaveBeenCalledTimes(2);
    expect(setup.preview.mock.calls[1]?.[0]).toMatchObject({
      input: { step: "plan", paths: ["src/a.ts"] },
    });
    expect(setup.refresh).not.toHaveBeenCalled();
  });
});
