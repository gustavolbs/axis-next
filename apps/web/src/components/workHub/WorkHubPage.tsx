import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  CalendarDaysIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  Columns3Icon,
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
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
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

type WorkHubView = "overview" | "calendar" | "messages" | "board";

const VIEWS: ReadonlyArray<{
  readonly id: WorkHubView;
  readonly label: string;
  readonly icon: typeof LayoutDashboardIcon;
}> = [
  { id: "overview", label: "Overview", icon: LayoutDashboardIcon },
  { id: "calendar", label: "Calendar", icon: CalendarDaysIcon },
  { id: "messages", label: "Messages", icon: InboxIcon },
  { id: "board", label: "Work Board", icon: Columns3Icon },
];

const BOARD_COLUMNS = ["To do", "Working", "Blocked", "Code review", "QA", "Done"] as const;

function contextTone(index: number): string {
  return ["bg-blue-500", "bg-violet-500", "bg-amber-500", "bg-emerald-500"][index % 4]!;
}

function EmptyCollection({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex min-h-32 items-center justify-center rounded-xl border border-dashed border-border/75 bg-muted/10 px-5 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function OverviewView({ catalog }: { readonly catalog: AxisContextCatalog }) {
  const sources = buildWorkHubSourceReadiness(catalog);
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
          <Badge variant="secondary">0 items</Badge>
        </div>
        <EmptyCollection>
          Work Hub will place today&apos;s MCP-backed activity here as sources finish connecting.
        </EmptyCollection>
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

function CalendarEvent({ item }: { readonly item: AxisWorkHubCachedItem }) {
  const startsAt = item.startsAt ? new Date(item.startsAt) : null;
  const endsAt = item.endsAt ? new Date(item.endsAt) : null;
  const meetingLink = item.meetingLink;
  return (
    <div className="h-full min-h-9 overflow-hidden rounded-md border border-primary/25 bg-primary/10 p-1.5 shadow-xs">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="block w-full truncate text-left text-xs font-medium text-foreground"
            />
          }
        >
          {item.title}
        </TooltipTrigger>
        <TooltipPopup side="right" className="max-w-72">
          <p className="font-medium">{item.title}</p>
          {startsAt ? (
            <p className="mt-1 text-xs">
              {startsAt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
              {endsAt
                ? ` – ${endsAt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
                : ""}
            </p>
          ) : null}
          {item.location ? <p className="mt-1 text-xs">{item.location}</p> : null}
          {item.summary ? (
            <p className="mt-1 text-xs text-muted-foreground">{item.summary}</p>
          ) : null}
        </TooltipPopup>
      </Tooltip>
      {meetingLink ? (
        <Button
          render={<a href={meetingLink} target="_blank" rel="noreferrer" />}
          size="xs"
          variant="ghost-muted"
          className="mt-1 h-5 px-1 text-[10px]"
        >
          <VideoIcon className="size-3" /> Join
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
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const days = useMemo(() => buildWorkHubWeekDays(now, weekOffset), [now, weekOffset]);
  const currentTimePosition = `${workHubCurrentTimePercentage(now)}%`;
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
          <div className="flex flex-wrap gap-3">
            {contexts.map((context, index) => (
              <span
                key={context.id}
                className="flex items-center gap-1.5 text-xs text-muted-foreground"
              >
                <span className={cn("size-2 rounded-full", contextTone(index))} />
                {context.name}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="overflow-x-auto">
        <div className="grid min-w-[46rem] grid-cols-7">
          {days.map((day) => {
            const isToday = day.toDateString() === now.toDateString();
            const dayItems = items.filter(
              (item) =>
                item.startsAt && new Date(item.startsAt).toDateString() === day.toDateString(),
            );
            return (
              <div
                key={day.toISOString()}
                className="relative min-h-[48rem] border-r border-border/60 bg-[linear-gradient(to_bottom,transparent_calc(4.166%-1px),var(--border)_4.166%,transparent_calc(4.166%+1px))] bg-[length:100%_4.166%] p-3 last:border-r-0"
              >
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {day.toLocaleDateString(undefined, { weekday: "short" })}
                </p>
                <p
                  className={cn(
                    "mt-1 flex size-8 items-center justify-center rounded-full text-lg font-medium text-foreground",
                    isToday && "bg-primary text-primary-foreground",
                  )}
                >
                  {day.getDate()}
                </p>
                <div className="absolute inset-x-2 top-16 bottom-2">
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
                    return (
                      <div
                        key={item.id}
                        className="absolute right-0 left-0"
                        style={{
                          top: `${(minute / (24 * 60)) * 100}%`,
                          height: `${(durationMinutes / (24 * 60)) * 100}%`,
                        }}
                      >
                        <CalendarEvent item={item} />
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

function MessagesView() {
  return (
    <section className="rounded-2xl border border-border/70 bg-card/35 p-5 shadow-sm/5">
      <div className="mb-4">
        <h2 className="font-medium text-foreground">Important messages</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Priority updates from Slack, Jira, and each Company&apos;s configured tools.
        </p>
      </div>
      <EmptyCollection>
        Messages selected by connected provider MCPs will appear here with their source context.
      </EmptyCollection>
    </section>
  );
}

function BoardView() {
  return (
    <div className="overflow-x-auto pb-2">
      <div className="grid min-w-[72rem] grid-cols-6 gap-3">
        {BOARD_COLUMNS.map((column) => (
          <section key={column} className="rounded-xl border border-border/70 bg-card/35 p-3">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-sm font-medium text-foreground">{column}</h2>
              <Badge variant="outline">0</Badge>
            </div>
            <div className="min-h-52 rounded-lg border border-dashed border-border/65 bg-muted/10" />
          </section>
        ))}
      </div>
    </div>
  );
}

export function WorkHubPage() {
  const [view, setView] = useState<WorkHubView>("overview");
  const environmentId = usePrimaryEnvironmentId();
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.axisContextCatalog({ environmentId, input: {} }),
  );
  const cacheQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.axisWorkHubCache({ environmentId, input: {} }),
  );
  const calendarItems = useMemo(() => {
    const selectedSourceIds = new Set(
      query.data?.catalog.workHubSources
        .filter((source) => source.enabled)
        .map((source) => source.id) ?? [],
    );
    return (
      cacheQuery.data?.flatMap((snapshot) =>
        selectedSourceIds.has(snapshot.sourceId)
          ? snapshot.items.filter((item) => item.view === "calendar")
          : [],
      ) ?? []
    );
  }, [cacheQuery.data, query.data]);

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
              {query.error ? <CircleAlertIcon className="size-6 text-destructive" /> : null}
              <div>
                <p className="text-sm font-medium text-foreground">
                  {query.error ? "Could not load Work Hub" : "Loading Work Hub"}
                </p>
                <p className="mt-1 max-w-md text-sm text-muted-foreground">
                  {query.error
                    ? "Restart or update the selected environment, then reload the Axis catalog."
                    : "Reading contexts and provider-connected MCP sources."}
                </p>
              </div>
              {query.error ? (
                <Button size="sm" onClick={query.refresh}>
                  Reload
                </Button>
              ) : null}
            </div>
          ) : view === "overview" ? (
            <OverviewView catalog={query.data.catalog} />
          ) : view === "calendar" ? (
            <CalendarView contexts={query.data.catalog.contexts} items={calendarItems} />
          ) : view === "messages" ? (
            <MessagesView />
          ) : (
            <BoardView />
          )}
        </main>
      </div>
    </SidebarInset>
  );
}
