import { useMemo, useState, type ReactNode } from "react";
import {
  CalendarDaysIcon,
  CircleAlertIcon,
  Columns3Icon,
  InboxIcon,
  LayoutDashboardIcon,
} from "lucide-react";

import { type AxisContext, type AxisContextCatalog } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { buildWorkHubSourceReadiness } from "./WorkHub.logic";
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

function CalendarView({ contexts }: { readonly contexts: ReadonlyArray<AxisContext> }) {
  const days = useMemo(() => {
    const today = new Date();
    const start = new Date(today);
    start.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    return Array.from({ length: 7 }, (_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      return date;
    });
  }, []);

  return (
    <section className="overflow-hidden rounded-2xl border border-border/70 bg-card/35 shadow-sm/5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-5 py-4">
        <div>
          <h2 className="font-medium text-foreground">This week</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Events remain labeled with their Personal or Company source.
          </p>
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
      <div className="overflow-x-auto">
        <div className="grid min-w-[46rem] grid-cols-7">
          {days.map((day) => (
            <div
              key={day.toISOString()}
              className="min-h-80 border-r border-border/60 p-3 last:border-r-0"
            >
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {day.toLocaleDateString(undefined, { weekday: "short" })}
              </p>
              <p className="mt-1 text-lg font-medium text-foreground">{day.getDate()}</p>
            </div>
          ))}
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
            <CalendarView contexts={query.data.catalog.contexts} />
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
