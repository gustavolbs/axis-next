import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  CalendarDaysIcon,
  CalendarClockIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  Columns3Icon,
  ExternalLinkIcon,
  InboxIcon,
  LayoutDashboardIcon,
  VideoIcon,
} from "lucide-react";

import {
  type AxisContext,
  type AxisContextCatalog,
  type AxisWorkHubCachedItem,
} from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { environmentCatalog } from "~/connection/catalog";
import { usePrimaryEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  buildWorkHubSourceReadiness,
  buildWorkHubWeekDays,
  workHubCurrentTimePercentage,
} from "./WorkHub.logic";
import { WorkHubSourceManager } from "./WorkHubSourceManager";
import { WorkHubScheduledActivities } from "./WorkHubScheduledActivities";

type WorkHubView = "overview" | "calendar" | "messages" | "board" | "scheduled";

const VIEWS: ReadonlyArray<{
  readonly id: WorkHubView;
  readonly label: string;
  readonly icon: typeof LayoutDashboardIcon;
}> = [
  { id: "overview", label: "Overview", icon: LayoutDashboardIcon },
  { id: "calendar", label: "Calendar", icon: CalendarDaysIcon },
  { id: "messages", label: "Messages", icon: InboxIcon },
  { id: "board", label: "Work Board", icon: Columns3Icon },
  { id: "scheduled", label: "Scheduled", icon: CalendarClockIcon },
];

const BOARD_COLUMNS = ["To do", "Working", "Blocked", "Code review", "QA", "Done"] as const;

const CALENDAR_HOUR_HEIGHT_PX = 64;
const CALENDAR_DAY_HEIGHT_PX = 24 * CALENDAR_HOUR_HEIGHT_PX;
const CALENDAR_HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const CONTEXT_TONES = [
  {
    dot: "bg-blue-500",
    strip: "border-l-blue-500",
    event: "border-blue-500/55 bg-blue-500/15 text-blue-950 hover:bg-blue-500/20 dark:text-blue-50",
  },
  {
    dot: "bg-violet-500",
    strip: "border-l-violet-500",
    event:
      "border-violet-500/55 bg-violet-500/15 text-violet-950 hover:bg-violet-500/20 dark:text-violet-50",
  },
  {
    dot: "bg-amber-500",
    strip: "border-l-amber-500",
    event:
      "border-amber-500/55 bg-amber-500/15 text-amber-950 hover:bg-amber-500/20 dark:text-amber-50",
  },
  {
    dot: "bg-emerald-500",
    strip: "border-l-emerald-500",
    event:
      "border-emerald-500/55 bg-emerald-500/15 text-emerald-950 hover:bg-emerald-500/20 dark:text-emerald-50",
  },
] as const;

function contextTone(index: number): string {
  return CONTEXT_TONES[index % CONTEXT_TONES.length]!.dot;
}

function contextStripTone(index: number): string {
  return CONTEXT_TONES[index % CONTEXT_TONES.length]!.strip;
}

function contextEventTone(index: number): string {
  return CONTEXT_TONES[index % CONTEXT_TONES.length]!.event;
}

function contextIndexOf(contexts: ReadonlyArray<AxisContext>, contextId: string): number {
  const index = contexts.findIndex((context) => context.id === contextId);
  return index === -1 ? 0 : index;
}

function ContextLegend({ contexts }: { readonly contexts: ReadonlyArray<AxisContext> }) {
  return (
    <div className="flex flex-wrap gap-3">
      {contexts.map((context, index) => (
        <span key={context.id} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className={cn("size-2 rounded-full", contextTone(index))} />
          {context.name}
        </span>
      ))}
    </div>
  );
}

function EmptyCollection({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex min-h-32 items-center justify-center rounded-xl border border-dashed border-border/75 bg-muted/10 px-5 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function contextName(contexts: ReadonlyArray<AxisContext>, contextId: string): string {
  return contexts.find((context) => context.id === contextId)?.name ?? contextId;
}

function OverviewView({
  catalog,
  items,
}: {
  readonly catalog: AxisContextCatalog;
  readonly items: ReadonlyArray<AxisWorkHubCachedItem>;
}) {
  const sources = buildWorkHubSourceReadiness(catalog);
  const today = new Date().toDateString();
  const todayItems = items
    .filter((item) => {
      const timestamp = item.startsAt ?? item.occurredAt;
      return item.view !== "board" && timestamp && new Date(timestamp).toDateString() === today;
    })
    .slice(0, 8);
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(18rem,0.55fr)]">
      <section className="rounded-2xl border border-border/70 bg-card/35 p-5 shadow-sm/5">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="font-medium text-foreground">Today</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Meetings, priority messages, and active work across every context.
            </p>
          </div>
          <Badge variant="secondary">{todayItems.length} items</Badge>
        </div>
        {todayItems.length === 0 ? (
          <EmptyCollection>
            Sync a selected MCP to place today&apos;s meetings and important messages here.
          </EmptyCollection>
        ) : (
          <div className="divide-y divide-border/60 rounded-xl border border-border/60">
            {todayItems.map((item) => (
              <div key={item.id} className="flex items-start gap-3 px-3 py-2.5">
                <Badge variant="outline" className="mt-0.5 shrink-0">
                  {item.view === "calendar" ? "Event" : "Message"}
                </Badge>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{item.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {contextName(catalog.contexts, item.contextId)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-border/70 bg-card/35 p-5 shadow-sm/5">
        <h2 className="font-medium text-foreground">Source readiness</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Data is read only through MCPs attached to providers available in each context.
        </p>
        <div className="mt-4 divide-y divide-border/65">
          {sources.map((source, index) => {
            return (
              <div
                key={source.contextId}
                className="flex items-center gap-3 py-3 first:pt-0 last:pb-0"
              >
                <span className={cn("size-2.5 shrink-0 rounded-full", contextTone(index))} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {source.contextName}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {source.providerCount} provider{source.providerCount === 1 ? "" : "s"} ·{" "}
                    {source.selectedMcpCount} of {source.availableMcpCount} MCPs selected
                  </p>
                </div>
                <Badge variant={source.selectedMcpCount > 0 ? "secondary" : "outline"}>
                  {source.selectedMcpCount > 0 ? "Ready" : "Select sources"}
                </Badge>
              </div>
            );
          })}
        </div>
      </section>
      <WorkHubSourceManager />
    </div>
  );
}

function calendarMeetingLink(item: AxisWorkHubCachedItem): string | null {
  if (item.meetingLink) return item.meetingLink;
  if (!item.location) return null;
  try {
    const url = new URL(item.location);
    const hostname = url.hostname.toLocaleLowerCase();
    const meetingHost = [
      "meet.google.com",
      "teams.microsoft.com",
      "teams.live.com",
      "zoom.us",
      "whereby.com",
      "webex.com",
      "meet.alex.com",
    ].some((host) => hostname === host || hostname.endsWith(`.${host}`));
    return meetingHost ? url.toString() : null;
  } catch {
    return null;
  }
}

function CalendarEvent({
  item,
  contextLabel,
  contextIndex,
}: {
  readonly item: AxisWorkHubCachedItem;
  readonly contextLabel: string;
  readonly contextIndex: number;
}) {
  const startsAt = item.startsAt ? new Date(item.startsAt) : null;
  const endsAt = item.endsAt ? new Date(item.endsAt) : null;
  const meetingLink = calendarMeetingLink(item);
  const timeLabel = startsAt
    ? `${startsAt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}${
        endsAt
          ? `–${endsAt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
          : ""
      }`
    : null;
  return (
    <div
      className={cn(
        "group relative h-full min-h-11 overflow-hidden rounded-md border-l-[3px] p-1.5 shadow-xs transition-colors",
        contextEventTone(contextIndex),
      )}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <div
              tabIndex={0}
              className="absolute inset-0 cursor-default p-1.5 pr-11 outline-none"
            />
          }
        >
          {timeLabel ? (
            <p className="truncate text-[10px] font-medium opacity-75">{timeLabel}</p>
          ) : null}
          <p className="truncate text-left text-xs font-semibold">{item.title}</p>
        </TooltipTrigger>
        <TooltipPopup side="right" align="start" className="w-72 max-w-[calc(100vw-2rem)] p-1.5">
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className={cn("size-2 shrink-0 rounded-full", contextTone(contextIndex))} />
            {contextLabel}
          </div>
          <p className="mt-1 font-medium text-foreground">{item.title}</p>
          {startsAt ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {startsAt.toLocaleDateString(undefined, {
                weekday: "long",
                month: "short",
                day: "numeric",
              })}
              {` · ${timeLabel}`}
            </p>
          ) : null}
          {item.location ? (
            <p className="mt-1 break-words text-xs text-muted-foreground">{item.location}</p>
          ) : null}
          {item.summary ? (
            <p className="mt-2 line-clamp-6 whitespace-pre-wrap text-xs text-muted-foreground">
              {item.summary}
            </p>
          ) : null}
        </TooltipPopup>
      </Tooltip>
      {meetingLink ? (
        <Button
          render={<a href={meetingLink} target="_blank" rel="noreferrer" />}
          size="xs"
          variant="secondary"
          className="absolute top-1 right-1 z-10 h-6 gap-1 px-1.5 text-[10px] shadow-sm"
          aria-label={`Join ${item.title}`}
        >
          <VideoIcon className="size-3" /> Join
        </Button>
      ) : item.deepLink ? (
        <Button
          render={<a href={item.deepLink} target="_blank" rel="noreferrer" />}
          size="icon-xs"
          variant="ghost-muted"
          className="absolute top-1 right-1 z-10 size-6"
          aria-label={`Open ${item.title}`}
        >
          <ExternalLinkIcon className="size-3" />
        </Button>
      ) : null}
    </div>
  );
}

function CalendarView({
  contexts,
  items,
}: {
  readonly contexts: ReadonlyArray<AxisContext>;
  readonly items: ReadonlyArray<AxisWorkHubCachedItem>;
}) {
  const [weekOffset, setWeekOffset] = useState(0);
  const [now, setNow] = useState(() => new Date());
  const calendarScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!calendarScrollRef.current) return;
    const firstVisibleHour = Math.max(0, new Date().getHours() - 2);
    calendarScrollRef.current.scrollTop = firstVisibleHour * CALENDAR_HOUR_HEIGHT_PX;
  }, []);
  const days = useMemo(() => buildWorkHubWeekDays(now, weekOffset), [now, weekOffset]);
  const currentTimePosition = `${workHubCurrentTimePercentage(now)}%`;
  const contextIndexes = useMemo(
    () => new Map(contexts.map((context, index) => [context.id, index])),
    [contexts],
  );
  const weekLabel = `${days[0]!.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })} – ${days[6]!.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  })}`;

  return (
    <section className="overflow-hidden rounded-2xl border border-border/70 bg-card/35 shadow-sm/5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-5 py-4">
        <div>
          <h2 className="font-medium text-foreground">{weekLabel}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Events remain labeled with their Personal or Company source.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          <div className="flex items-center gap-1">
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label="Previous week"
              onClick={() => setWeekOffset((value) => value - 1)}
            >
              <ChevronLeftIcon />
            </Button>
            <Button size="xs" variant="outline" onClick={() => setWeekOffset(0)}>
              Today
            </Button>
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label="Next week"
              onClick={() => setWeekOffset((value) => value + 1)}
            >
              <ChevronRightIcon />
            </Button>
          </div>
          <ContextLegend contexts={contexts} />
        </div>
      </div>
      <div
        ref={calendarScrollRef}
        className="max-h-[calc(100dvh-14rem)] min-h-[32rem] overflow-auto"
      >
        <div className="grid min-w-[64rem] grid-cols-[4.5rem_repeat(7,minmax(8.5rem,1fr))]">
          <div className="relative border-r border-foreground/15 bg-card/75">
            <div className="sticky top-0 z-30 flex h-16 items-end justify-end border-b border-border/70 bg-card px-2 pb-2 text-[10px] text-muted-foreground">
              Time
            </div>
            <div className="relative" style={{ height: CALENDAR_DAY_HEIGHT_PX }}>
              {CALENDAR_HOURS.map((hour) => (
                <span
                  key={hour}
                  className="absolute right-2 -translate-y-1/2 text-[10px] tabular-nums text-muted-foreground"
                  style={{ top: hour * CALENDAR_HOUR_HEIGHT_PX }}
                >
                  {hour.toString().padStart(2, "0")}:00
                </span>
              ))}
            </div>
          </div>
          {days.map((day) => {
            const isToday = day.toDateString() === now.toDateString();
            const dayItems = items.filter(
              (item) =>
                item.startsAt && new Date(item.startsAt).toDateString() === day.toDateString(),
            );
            return (
              <div
                key={day.toISOString()}
                className="relative border-r border-foreground/15 last:border-r-0"
              >
                <div className="sticky top-0 z-20 flex h-16 flex-col items-center justify-center border-b border-border/70 bg-card/95 backdrop-blur-sm">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {day.toLocaleDateString(undefined, { weekday: "short" })}
                  </p>
                  <p
                    className={cn(
                      "mt-0.5 flex size-8 items-center justify-center rounded-full text-base font-medium text-foreground",
                      isToday && "bg-primary text-primary-foreground",
                    )}
                  >
                    {day.getDate()}
                  </p>
                </div>
                <div
                  className="relative bg-[linear-gradient(to_bottom,transparent_calc(100%_-_1px),color-mix(in_srgb,var(--foreground)_15%,transparent))]"
                  style={{
                    height: CALENDAR_DAY_HEIGHT_PX,
                    backgroundSize: `100% ${CALENDAR_HOUR_HEIGHT_PX}px`,
                  }}
                >
                  {isToday ? (
                    <div
                      className="pointer-events-none absolute right-0 left-0 z-10 flex items-center"
                      style={{ top: currentTimePosition }}
                      aria-label="Current time"
                    >
                      <span className="size-2 -translate-x-1 rounded-full bg-destructive" />
                      <span className="h-px flex-1 bg-destructive" />
                    </div>
                  ) : null}
                  {dayItems.map((item) => {
                    const start = new Date(item.startsAt!);
                    const end = item.endsAt ? new Date(item.endsAt) : null;
                    const minute = start.getHours() * 60 + start.getMinutes();
                    const durationMinutes = end
                      ? Math.max(30, (end.getTime() - start.getTime()) / 60_000)
                      : 60;
                    const top = (minute / 60) * CALENDAR_HOUR_HEIGHT_PX;
                    const height = Math.max(44, (durationMinutes / 60) * CALENDAR_HOUR_HEIGHT_PX);
                    const contextIndex = contextIndexes.get(item.contextId) ?? 0;
                    return (
                      <div
                        key={item.id}
                        className="absolute right-1 left-1"
                        style={{
                          top,
                          height: Math.min(height, CALENDAR_DAY_HEIGHT_PX - top),
                        }}
                      >
                        <CalendarEvent
                          item={item}
                          contextLabel={contextName(contexts, item.contextId)}
                          contextIndex={contextIndex}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function MessagesView({
  contexts,
  items,
}: {
  readonly contexts: ReadonlyArray<AxisContext>;
  readonly items: ReadonlyArray<AxisWorkHubCachedItem>;
}) {
  const sorted = [...items].sort(
    (left, right) => Date.parse(right.occurredAt ?? "") - Date.parse(left.occurredAt ?? ""),
  );
  return (
    <section className="rounded-2xl border border-border/70 bg-card/35 p-5 shadow-sm/5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-medium text-foreground">Important messages</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Priority updates from Slack, Jira, and each Company&apos;s configured tools.
          </p>
        </div>
        <ContextLegend contexts={contexts} />
      </div>
      {sorted.length === 0 ? (
        <EmptyCollection>
          Sync Slack, Jira, or another selected MCP to load DMs, mentions, and new assigned-ticket
          comments.
        </EmptyCollection>
      ) : (
        <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60">
          {sorted.map((item) => (
            <article
              key={item.id}
              className={cn(
                "flex items-start gap-3 border-l-[3px] p-3",
                contextStripTone(contextIndexOf(contexts, item.contextId)),
              )}
            >
              <Badge variant="outline" className="mt-0.5 shrink-0">
                {item.kind === "direct-message"
                  ? "DM"
                  : item.kind === "mention"
                    ? "Mention"
                    : "Comment"}
              </Badge>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <h3 className="text-sm font-medium">{item.title}</h3>
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span
                      className={cn(
                        "size-2 shrink-0 rounded-full",
                        contextTone(contextIndexOf(contexts, item.contextId)),
                      )}
                    />
                    {contextName(contexts, item.contextId)}
                  </span>
                </div>
                {item.summary ? (
                  <p className="mt-1 text-sm text-muted-foreground">{item.summary}</p>
                ) : null}
                {item.occurredAt ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {new Date(item.occurredAt).toLocaleString()}
                  </p>
                ) : null}
              </div>
              {item.deepLink ? (
                <Button
                  render={<a href={item.deepLink} target="_blank" rel="noreferrer" />}
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={`Open ${item.title}`}
                >
                  <ExternalLinkIcon />
                </Button>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function boardColumn(status: string | null): (typeof BOARD_COLUMNS)[number] {
  const normalized = status?.trim().toLocaleLowerCase().replaceAll("_", " ") ?? "";
  if (normalized.includes("block")) return "Blocked";
  if (normalized.includes("review")) return "Code review";
  if (normalized === "qa" || normalized.includes("quality")) return "QA";
  if (normalized.includes("done") || normalized.includes("closed")) return "Done";
  if (
    normalized.includes("progress") ||
    normalized.includes("working") ||
    normalized.includes("doing")
  )
    return "Working";
  return "To do";
}

function BoardView({
  contexts,
  items,
}: {
  readonly contexts: ReadonlyArray<AxisContext>;
  readonly items: ReadonlyArray<AxisWorkHubCachedItem>;
}) {
  return (
    <div>
      <div className="mb-3 flex justify-end">
        <ContextLegend contexts={contexts} />
      </div>
      <div className="overflow-x-auto pb-2">
        <div className="grid min-w-[90rem] grid-cols-5 gap-3">
          {BOARD_COLUMNS.filter((column) => column !== "Done").map((column) => {
            const columnItems = items.filter((item) => boardColumn(item.status) === column);
            return (
              <section key={column} className="rounded-xl border border-border/70 bg-card/35 p-3">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h2 className="text-sm font-medium text-foreground">{column}</h2>
                  <Badge variant="outline">{columnItems.length}</Badge>
                </div>
                <div className="grid min-h-52 content-start gap-2">
                  {columnItems.map((item) => (
                    <article
                      key={item.id}
                      className={cn(
                        "rounded-lg border border-border/65 border-l-[3px] bg-background/60 p-3",
                        contextStripTone(contextIndexOf(contexts, item.contextId)),
                      )}
                    >
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <h3 className="text-sm font-medium">{item.title}</h3>
                          <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                            <span
                              className={cn(
                                "size-2 shrink-0 rounded-full",
                                contextTone(contextIndexOf(contexts, item.contextId)),
                              )}
                            />
                            {contextName(contexts, item.contextId)}
                          </p>
                        </div>
                        {item.deepLink ? (
                          <Button
                            render={<a href={item.deepLink} target="_blank" rel="noreferrer" />}
                            size="icon-xs"
                            variant="ghost-muted"
                            aria-label={`Open ${item.title}`}
                          >
                            <ExternalLinkIcon />
                          </Button>
                        ) : null}
                      </div>
                      {item.summary ? (
                        <p className="mt-2 line-clamp-3 text-xs text-muted-foreground">
                          {item.summary}
                        </p>
                      ) : null}
                    </article>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function WorkHubPage() {
  const [view, setView] = useState<WorkHubView>("overview");
  const [reconnecting, setReconnecting] = useState(false);
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const axisSupported = primaryEnvironment?.serverConfig?.environment.capabilities.axis === true;
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const query = useEnvironmentQuery(
    environmentId === null || !axisSupported
      ? null
      : serverEnvironment.axisContextCatalog({ environmentId, input: {} }),
  );
  const cacheQuery = useEnvironmentQuery(
    environmentId === null || !axisSupported
      ? null
      : serverEnvironment.axisWorkHubCache({ environmentId, input: {} }),
  );
  const cachedItems = useMemo(() => {
    const selectedSourceIds = new Set(
      query.data?.catalog.workHubSources
        .filter((source) => source.enabled)
        .map((source) => source.id) ?? [],
    );
    return (
      cacheQuery.data?.flatMap((snapshot) =>
        selectedSourceIds.has(snapshot.sourceId) ? snapshot.items : [],
      ) ?? []
    );
  }, [cacheQuery.data, query.data]);
  const reconnect = async () => {
    if (environmentId === null || reconnecting) return;
    setReconnecting(true);
    const result = await retryEnvironment(environmentId);
    setReconnecting(false);
    if (result._tag === "Success") {
      query.refresh();
      cacheQuery.refresh();
    }
  };
  const isConnected = primaryEnvironment?.connection.phase === "connected";
  const needsUpdate = isConnected && primaryEnvironment.serverConfig !== null && !axisSupported;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader className="border-b border-border/70">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold text-foreground">Work Hub</h1>
            <p className="hidden text-xs text-muted-foreground sm:block">
              One view across Personal and every Company, without crossing their data boundaries.
            </p>
          </div>
        </WorkspacePageHeader>

        <div className="border-b border-border/70 px-3 sm:px-5">
          <nav className="flex gap-1 overflow-x-auto py-2" aria-label="Work Hub views">
            {VIEWS.map((item) => {
              const Icon = item.icon;
              return (
                <Button
                  key={item.id}
                  size="sm"
                  variant={view === item.id ? "secondary" : "ghost"}
                  aria-current={view === item.id ? "page" : undefined}
                  onClick={() => setView(item.id)}
                >
                  <Icon className="size-4" />
                  {item.label}
                </Button>
              );
            })}
          </nav>
        </div>

        <main className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-5">
          {environmentId === null ? (
            <EmptyCollection>Connect a primary environment to load Work Hub.</EmptyCollection>
          ) : !query.data ? (
            <div className="flex min-h-56 flex-col items-center justify-center gap-3 rounded-2xl border border-border/70 bg-card/35 px-5 text-center">
              {query.error || needsUpdate || !isConnected ? (
                <CircleAlertIcon className="size-6 text-destructive" />
              ) : null}
              <div>
                <p className="text-sm font-medium text-foreground">
                  {needsUpdate
                    ? "Work Hub requires a backend update"
                    : !isConnected
                      ? "Primary environment is offline"
                      : query.error
                        ? "Could not load Work Hub"
                        : "Loading Work Hub"}
                </p>
                <p className="mt-1 max-w-md text-sm text-muted-foreground">
                  {needsUpdate
                    ? "Update or restart the primary environment with an Axis-enabled build. Retrying an older backend cannot load Work Hub."
                    : !isConnected
                      ? "Reconnect the primary environment to load cached MCP data."
                      : query.error
                        ? "The Axis request failed after the environment connected. Retry the request."
                        : "Reading contexts and provider-connected MCP sources."}
                </p>
              </div>
              {!isConnected ? (
                <Button size="sm" disabled={reconnecting} onClick={() => void reconnect()}>
                  {reconnecting ? "Reconnecting…" : "Reconnect"}
                </Button>
              ) : query.error ? (
                <Button size="sm" onClick={query.refresh}>
                  Retry request
                </Button>
              ) : null}
            </div>
          ) : view === "overview" ? (
            <OverviewView catalog={query.data.catalog} items={cachedItems} />
          ) : view === "calendar" ? (
            <CalendarView
              contexts={query.data.catalog.contexts}
              items={cachedItems.filter((item) => item.view === "calendar")}
            />
          ) : view === "messages" ? (
            <MessagesView
              contexts={query.data.catalog.contexts}
              items={cachedItems.filter((item) => item.view === "messages")}
            />
          ) : view === "scheduled" ? (
            <WorkHubScheduledActivities
              catalog={query.data.catalog}
              environmentId={environmentId}
              onWorkHubCacheChanged={cacheQuery.refresh}
            />
          ) : (
            <BoardView
              contexts={query.data.catalog.contexts}
              items={cachedItems.filter((item) => item.view === "board")}
            />
          )}
        </main>
      </div>
    </SidebarInset>
  );
}
