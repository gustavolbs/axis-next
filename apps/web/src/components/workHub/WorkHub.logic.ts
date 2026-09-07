import {
  axisProviderInstanceLocatorKey,
  resolveAxisContextProviderInstances,
  type AxisContextCatalog,
  type AxisWorkHubCachedItem,
} from "@t3tools/contracts";

export const WORK_HUB_BOARD_COLUMNS = [
  "To do",
  "Working",
  "Blocked",
  "Code review",
  "QA",
  "Done",
] as const;
export type WorkHubBoardColumn = (typeof WORK_HUB_BOARD_COLUMNS)[number] | "Unmapped";

export function resolveWorkHubBoardColumn(status: string | null): WorkHubBoardColumn {
  const normalized = status?.trim().toLocaleLowerCase().replaceAll("_", " ") ?? "";
  if (normalized.includes("block")) return "Blocked";
  if (normalized.includes("review")) return "Code review";
  if (normalized === "qa" || normalized.includes("quality")) return "QA";
  if (normalized.includes("done") || normalized.includes("closed")) return "Done";
  if (normalized === "todo" || normalized === "to do" || normalized.includes("backlog")) {
    return "To do";
  }
  if (
    normalized.includes("progress") ||
    normalized.includes("working") ||
    normalized.includes("doing")
  ) {
    return "Working";
  }
  return "Unmapped";
}

export function isWorkHubOverviewItem(item: AxisWorkHubCachedItem, now: Date): boolean {
  if (item.view === "board") return resolveWorkHubBoardColumn(item.status) !== "Done";
  const timestamp = item.startsAt ?? item.occurredAt;
  return timestamp !== null && new Date(timestamp).toDateString() === now.toDateString();
}

export function buildWorkHubWeekDays(anchor: Date, weekOffset: number): ReadonlyArray<Date> {
  const start = new Date(anchor);
  start.setHours(0, 0, 0, 0);
  start.setDate(anchor.getDate() - anchor.getDay() + weekOffset * 7);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return date;
  });
}

export function workHubCurrentTimePercentage(now: Date): number {
  return ((now.getHours() * 60 + now.getMinutes()) / (24 * 60)) * 100;
}

export interface WorkHubCalendarInterval<T> {
  readonly value: T;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly sortKey: string;
}

export interface WorkHubCalendarLayout<T> extends WorkHubCalendarInterval<T> {
  readonly column: number;
  readonly columnCount: number;
}

interface ActiveCalendarColumn {
  readonly column: number;
  readonly endMinute: number;
}

function heapPush<T>(heap: Array<T>, value: T, compare: (left: T, right: T) => number): void {
  heap.push(value);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compare(heap[parent]!, value) <= 0) break;
    heap[index] = heap[parent]!;
    index = parent;
  }
  heap[index] = value;
}

function heapPop<T>(heap: Array<T>, compare: (left: T, right: T) => number): T | undefined {
  const first = heap[0];
  const last = heap.pop();
  if (heap.length === 0 || last === undefined) return first;

  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    if (left >= heap.length) break;
    const right = left + 1;
    const child = right < heap.length && compare(heap[right]!, heap[left]!) < 0 ? right : left;
    if (compare(heap[child]!, last) >= 0) break;
    heap[index] = heap[child]!;
    index = child;
  }
  heap[index] = last;
  return first;
}

/** Assigns stable, equal-width columns to each connected group of overlapping events. */
export function layoutWorkHubCalendarEvents<T>(
  intervals: ReadonlyArray<WorkHubCalendarInterval<T>>,
): ReadonlyArray<WorkHubCalendarLayout<T>> {
  const sorted = [...intervals].sort(
    (left, right) =>
      left.startMinute - right.startMinute ||
      right.endMinute - left.endMinute ||
      (left.sortKey < right.sortKey ? -1 : left.sortKey > right.sortKey ? 1 : 0),
  );
  const result: Array<WorkHubCalendarLayout<T>> = [];
  const active: Array<ActiveCalendarColumn> = [];
  const freeColumns: Array<number> = [];
  let nextColumn = 0;
  let clusterStart = 0;
  let clusterColumnCount = 0;

  const compareActive = (left: ActiveCalendarColumn, right: ActiveCalendarColumn) =>
    left.endMinute - right.endMinute || left.column - right.column;
  const compareColumn = (left: number, right: number) => left - right;
  const finishCluster = () => {
    for (let index = clusterStart; index < result.length; index += 1) {
      result[index] = { ...result[index]!, columnCount: clusterColumnCount };
    }
    clusterStart = result.length;
    clusterColumnCount = 0;
    nextColumn = 0;
    freeColumns.length = 0;
  };

  for (const interval of sorted) {
    while (active[0] && active[0].endMinute <= interval.startMinute) {
      const released = heapPop(active, compareActive)!;
      heapPush(freeColumns, released.column, compareColumn);
    }
    if (active.length === 0 && result.length > clusterStart) finishCluster();

    const column = heapPop(freeColumns, compareColumn) ?? nextColumn++;
    const endMinute = Math.max(interval.startMinute + 1, interval.endMinute);
    heapPush(active, { column, endMinute }, compareActive);
    clusterColumnCount = Math.max(clusterColumnCount, active.length);
    result.push({ ...interval, endMinute, column, columnCount: 1 });
  }
  if (result.length > clusterStart) finishCluster();
  return result;
}

export function resolveWorkHubCalendarMeetingLink(item: AxisWorkHubCachedItem): string | null {
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

export function buildWorkHubSourceReadiness(catalog: AxisContextCatalog) {
  return catalog.contexts.map((context) => {
    const providers = resolveAxisContextProviderInstances(catalog, context.id);
    const providerKeys = new Set(providers.map(axisProviderInstanceLocatorKey));
    const availableMcps = catalog.capabilities.filter(
      (capability) =>
        capability.kind === "mcp" &&
        capability.enabled &&
        providerKeys.has(axisProviderInstanceLocatorKey(capability.provider)),
    );
    const availableMcpIds = new Set(availableMcps.map((capability) => capability.id));
    const selectedMcpCount = catalog.workHubSources.filter(
      (source) =>
        source.contextId === context.id &&
        source.enabled &&
        availableMcpIds.has(source.capabilityId),
    ).length;

    return {
      contextId: context.id,
      contextKind: context.kind,
      contextName: context.name,
      providerCount: providers.length,
      availableMcpCount: availableMcps.length,
      selectedMcpCount,
    } as const;
  });
}

export function buildWorkHubSourceGroups(catalog: AxisContextCatalog) {
  return catalog.contexts.map((context) => ({
    context,
    providers: resolveAxisContextProviderInstances(catalog, context.id).map((provider) => {
      const providerKey = axisProviderInstanceLocatorKey(provider);
      const mcps = catalog.capabilities.filter(
        (capability) =>
          capability.kind === "mcp" &&
          capability.enabled &&
          axisProviderInstanceLocatorKey(capability.provider) === providerKey,
      );
      const selectedCapabilityIds = new Set(
        catalog.workHubSources
          .filter(
            (source) =>
              source.contextId === context.id &&
              source.enabled &&
              axisProviderInstanceLocatorKey(source.provider) === providerKey,
          )
          .map((source) => source.capabilityId),
      );
      return { provider, mcps, selectedCapabilityIds } as const;
    }),
  }));
}
