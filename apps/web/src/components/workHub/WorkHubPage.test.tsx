import type { AxisContext, AxisWorkHubCachedItem } from "@t3tools/contracts";
import {
  act,
  cloneElement,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../ui/tooltip", async () => {
  const React = await import("react");
  const TooltipContext = React.createContext<
    { readonly open: boolean; readonly setOpen: (open: boolean) => void } | undefined
  >(undefined);
  return {
    Tooltip({ children }: { readonly children: ReactNode }) {
      const [open, setOpen] = React.useState(false);
      const value = React.useMemo(() => ({ open, setOpen }), [open]);
      return <TooltipContext.Provider value={value}>{children}</TooltipContext.Provider>;
    },
    TooltipTrigger({
      render,
      children,
    }: ComponentProps<typeof import("../ui/tooltip").TooltipTrigger>) {
      const state = React.useContext(TooltipContext);
      if (!isValidElement(render)) return <>{children}</>;
      return cloneElement(
        render as ReactElement<{ readonly onFocus?: () => void }>,
        { onFocus: () => state?.setOpen(true) },
        children,
      );
    },
    TooltipPopup({ children }: { readonly children: ReactNode }) {
      const state = React.useContext(TooltipContext);
      return state?.open ? <div role="tooltip">{children}</div> : null;
    },
  };
});

import { CalendarView } from "./WorkHubPage";
import { isWorkHubView } from "./WorkHub.logic";

const contexts = [
  {
    id: "personal",
    kind: "personal",
    name: "Personal",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "company",
    kind: "company",
    name: "Acme",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
] as unknown as ReadonlyArray<AxisContext>;

function event(
  id: string,
  contextId: "personal" | "company",
  startsAt: Date,
  endsAt: Date,
  overrides: Partial<AxisWorkHubCachedItem> = {},
): AxisWorkHubCachedItem {
  return {
    id,
    sourceId: "calendar",
    contextId,
    kind: "calendar-event",
    view: "calendar",
    nativeId: id,
    title: id,
    summary: null,
    occurredAt: null,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    allDay: false,
    startDate: null,
    endDate: null,
    sourceTimeZone: null,
    calendar: null,
    organizer: null,
    participants: [],
    responseStatus: null,
    recurrence: null,
    cancelled: false,
    status: null,
    assignee: null,
    priority: null,
    dueDate: null,
    labels: [],
    project: null,
    sourceUpdatedAt: null,
    deepLink: null,
    meetingLink: null,
    location: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as AxisWorkHubCachedItem;
}

function nodeText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : nodeText(child)))
    .join("");
}

function eventContainer(renderer: ReactTestRenderer, title: string): ReactTestInstance {
  const titleNode = renderer.root.find(
    (node) => node.type === "p" && node.children.length === 1 && node.children[0] === title,
  );
  let current = titleNode.parent;
  while (
    current &&
    !(
      current.type === "div" &&
      typeof current.props.style === "object" &&
      current.props.style !== null &&
      "top" in current.props.style
    )
  ) {
    current = current.parent;
  }
  if (!current) throw new Error(`Missing calendar event container for ${title}`);
  return current;
}

async function renderCalendar(items: ReadonlyArray<AxisWorkHubCachedItem>) {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<CalendarView contexts={contexts} items={items} />);
  });
  return renderer!;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Work Hub calendar component", () => {
  it("positions overlaps side by side, preserves context colors, and exposes join details", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", { setInterval: vi.fn(() => 1), clearInterval: vi.fn() });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 5, 12));
    const planning = event(
      "Planning",
      "personal",
      new Date(2026, 8, 5, 9),
      new Date(2026, 8, 5, 11),
      {
        meetingLink: "https://meet.example.com/planning",
        organizer: { name: "Ada", email: "ada@example.com" },
        summary: "Quarterly planning details",
      },
    );
    const review = event("Review", "company", new Date(2026, 8, 5, 10), new Date(2026, 8, 5, 11));
    const renderer = await renderCalendar([planning, review]);

    try {
      expect(eventContainer(renderer, "Planning").props.style).toMatchObject({
        top: 576,
        height: 128,
        left: "0%",
        width: "50%",
      });
      expect(eventContainer(renderer, "Review").props.style).toMatchObject({
        top: 640,
        height: 64,
        left: "50%",
        width: "50%",
      });

      const planningEvent = eventContainer(renderer, "Planning").find(
        (node) => node.type === "div" && String(node.props.className).includes("group"),
      );
      const reviewEvent = eventContainer(renderer, "Review").find(
        (node) => node.type === "div" && String(node.props.className).includes("group"),
      );
      expect(planningEvent.props.className).toContain("bg-blue-500/15");
      expect(reviewEvent.props.className).toContain("bg-violet-500/15");

      const joinLink = renderer.root.find(
        (node) => node.type === "a" && node.props["aria-label"] === "Join Planning",
      );
      expect(joinLink.props).toMatchObject({
        href: "https://meet.example.com/planning",
        target: "_blank",
        rel: "noreferrer",
      });

      const tooltipTrigger = planningEvent.findByProps({ tabIndex: 0 });
      await act(async () => tooltipTrigger.props.onFocus());
      const tooltip = renderer.root.findByProps({ role: "tooltip" });
      expect(nodeText(tooltip)).toContain("Personal");
      expect(nodeText(tooltip)).toContain("Organizer · Ada");
      expect(nodeText(tooltip)).toContain("Quarterly planning details");
    } finally {
      await act(async () => renderer.unmount());
    }
  });

  it("moves cross-week events between Saturday and Sunday when navigating", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", { setInterval: vi.fn(() => 1), clearInterval: vi.fn() });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 5, 12));
    const overnight = event(
      "Overnight",
      "personal",
      new Date(2026, 8, 5, 23),
      new Date(2026, 8, 6, 1),
    );
    const renderer = await renderCalendar([overnight]);

    try {
      expect(eventContainer(renderer, "Overnight").props.style).toMatchObject({
        top: 1472,
        height: 64,
      });
      await act(async () =>
        renderer.root.findByProps({ "aria-label": "Next week" }).props.onClick(),
      );
      expect(eventContainer(renderer, "Overnight").props.style).toMatchObject({
        top: 0,
        height: 64,
      });
      await act(async () =>
        renderer.root.findByProps({ "aria-label": "Previous week" }).props.onClick(),
      );
      expect(eventContainer(renderer, "Overnight").props.style.top).toBe(1472);
    } finally {
      await act(async () => renderer.unmount());
    }
  });

  it("uses wall-clock positioning across the spring DST boundary", async () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = "America/New_York";
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", { setInterval: vi.fn(() => 1), clearInterval: vi.fn() });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 8, 12));
    const dstEvent = event(
      "DST planning",
      "company",
      new Date(2026, 2, 8, 1, 30),
      new Date(2026, 2, 8, 3, 30),
    );
    const renderer = await renderCalendar([dstEvent]);

    try {
      expect(eventContainer(renderer, "DST planning").props.style).toMatchObject({
        top: 96,
        height: 128,
      });
    } finally {
      await act(async () => renderer.unmount());
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });
});

describe("Work Hub views", () => {
  it("accepts shareable work views and rejects unknown values", () => {
    expect(isWorkHubView("calendar")).toBe(true);
    expect(isWorkHubView("sources")).toBe(true);
    expect(isWorkHubView("unknown")).toBe(false);
    expect(isWorkHubView(undefined)).toBe(false);
  });
});
