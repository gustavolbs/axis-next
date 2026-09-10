import { assert, it } from "@effect/vitest";
import {
  AxisCapabilityId,
  AxisContextId,
  EnvironmentId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { describe, expect, vi } from "vite-plus/test";

import {
  AxisTrelloMcpReadError,
  AxisTrelloSourceError,
  makeAxisTrelloSource,
  normalizeAxisTrelloCardToWorkHubItem,
  normalizeAxisTrelloCard,
  readAxisTrelloSource,
  toAxisTaskSource,
  type AxisTrelloMcpBinding,
  type AxisTrelloSourceConfig,
} from "./AxisTrelloSource.ts";

const environmentId = EnvironmentId.make("trello-test-environment");
const contextId = AxisContextId.make("trello-test-context");
const providerInstanceId = ProviderInstanceId.make("codex-trello");
const capabilityId = AxisCapabilityId.make("trello-read");
const config: AxisTrelloSourceConfig = {
  environmentId,
  contextId,
  provider: { environmentId, instanceId: providerInstanceId },
  capabilityId,
  mcpName: "Trello",
  boardId: "board-1",
  statusMap: {
    Backlog: "backlog",
    Doing: "in-progress",
    Done: "done",
  },
  maxCards: 20,
};

function binding(readCards: AxisTrelloMcpBinding["readCards"]): AxisTrelloMcpBinding {
  return {
    identity: {
      environmentId,
      contextId,
      provider: config.provider,
      capabilityId,
      mcpName: config.mcpName,
    },
    readCards,
  };
}

describe("AxisTrelloSource", () => {
  it.effect("normalizes native cards without losing identity, metadata, or cursor", () => {
    const readCards = vi.fn<AxisTrelloMcpBinding["readCards"]>(() =>
      Effect.succeed({
        cards: [
          {
            id: "card-1",
            name: "Ship the checkout fix",
            url: "https://trello.com/c/card-1/ship-the-checkout-fix",
            labels: [{ name: "release" }, { name: "payments" }],
            list: { name: "Doing" },
          },
        ],
        cursor: "cursor-2",
      }),
    );

    return Effect.gen(function* () {
      const result = yield* readAxisTrelloSource({ config, binding: binding(readCards) });
      expect(result).toEqual({
        items: [
          {
            kind: "assigned-work-item",
            view: "board",
            nativeId: "card-1",
            title: "Ship the checkout fix",
            summary: null,
            occurredAt: null,
            startsAt: null,
            endsAt: null,
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
            status: "in-progress",
            statusMapping: { kind: "mapped", native: "Doing", value: "in-progress" },
            assignee: null,
            priority: null,
            dueDate: null,
            labels: ["release", "payments"],
            project: null,
            sourceUpdatedAt: null,
            deepLink: "https://trello.com/c/card-1/ship-the-checkout-fix",
            meetingLink: null,
            location: null,
          },
        ],
        cursor: "cursor-2",
      });
      expect(readCards).toHaveBeenCalledWith({
        boardId: "board-1",
        cursor: null,
        limit: 20,
      });
    });
  });

  it.effect("keeps homonymous cards distinct by native ID", () => {
    const readCards = () =>
      Effect.succeed({
        cards: [
          { id: "card-a", name: "Same title", labels: [] },
          { id: "card-b", name: "Same title", labels: [] },
        ],
        cursor: null,
      });
    return Effect.gen(function* () {
      const result = yield* readAxisTrelloSource({ config, binding: binding(readCards) });
      assert.deepEqual(
        result.items.map((item) => item.nativeId),
        ["card-a", "card-b"],
      );
    });
  });

  it("keeps an unknown status explicitly unmapped", () => {
    const item = normalizeAxisTrelloCard(
      { id: "card-unknown", name: "Needs triage", status: "Waiting", labels: [] },
      config,
    );
    expect(item.status).toEqual({ kind: "unmapped", native: "Waiting" });
  });

  it.effect("does not accept a binding from another source identity", () => {
    const readCards = vi.fn<AxisTrelloMcpBinding["readCards"]>(() =>
      Effect.succeed({ cards: [], cursor: null }),
    );
    return Effect.gen(function* () {
      const failure = yield* readAxisTrelloSource({
        config,
        binding: {
          ...binding(readCards),
          identity: { ...binding(readCards).identity, contextId: AxisContextId.make("other") },
        },
      }).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(AxisTrelloSourceError);
      expect(failure.code).toBe("authorization");
      expect(readCards).not.toHaveBeenCalled();
    });
  });

  it.effect("leaves the previous snapshot untouched and permits an explicit retry", () => {
    let attempts = 0;
    const readCards = vi.fn<AxisTrelloMcpBinding["readCards"]>(() => {
      attempts += 1;
      return attempts === 1
        ? Effect.fail(new AxisTrelloMcpReadError({ message: "401 Unauthorized" }))
        : Effect.succeed({
            cards: [{ id: "card-1", name: "Recovered", labels: [] }],
            cursor: "next",
          });
    });
    const source = makeAxisTrelloSource();
    return Effect.gen(function* () {
      const confirmed = yield* source.read({
        config,
        binding: binding(() =>
          Effect.succeed({
            cards: [{ id: "old", name: "Previous", labels: [] }],
            cursor: "old-cursor",
          }),
        ),
      });
      expect(confirmed.cursor).toBe("old-cursor");
      const firstFailure = yield* source
        .read({
          config,
          binding: binding(readCards),
        })
        .pipe(Effect.flip);
      expect(firstFailure.code).toBe("authorization");
      expect(source.getSnapshot()?.items[0]?.nativeId).toBe("old");

      const retry = yield* source.retry({
        config,
        binding: binding(readCards),
      });
      expect(retry.items[0]?.nativeId).toBe("card-1");
      expect(retry.cursor).toBe("next");
      expect(readCards).toHaveBeenCalledTimes(2);
    });
  });

  it.effect("reports malformed pages and over-limit responses instead of truncating", () => {
    const malformed = readAxisTrelloSource({
      config,
      binding: binding(() => Effect.succeed({ items: [], cursor: null })),
    }).pipe(Effect.flip);
    const overLimit = readAxisTrelloSource({
      config: { ...config, maxCards: 1 },
      binding: binding(() =>
        Effect.succeed({
          cards: [
            { id: "one", name: "One", labels: [] },
            { id: "two", name: "Two", labels: [] },
          ],
          cursor: null,
        }),
      ),
    }).pipe(Effect.flip);
    return Effect.gen(function* () {
      const malformedFailure = yield* malformed;
      const overLimitFailure = yield* overLimit;
      expect(malformedFailure.code).toBe("invalid-response");
      expect(overLimitFailure.code).toBe("limit-exceeded");
    });
  });

  it.effect("rejects every mismatched binding identity before invoking MCP", () => {
    const readCards = vi.fn<AxisTrelloMcpBinding["readCards"]>(() =>
      Effect.succeed({ cards: [], cursor: null }),
    );
    const mismatches: ReadonlyArray<Partial<AxisTrelloMcpBinding["identity"]>> = [
      { environmentId: EnvironmentId.make("other-environment") },
      { contextId: AxisContextId.make("other-context") },
      { provider: { environmentId, instanceId: ProviderInstanceId.make("other-provider") } },
      { capabilityId: AxisCapabilityId.make("other-capability") },
      { mcpName: "Other MCP" },
    ];
    return Effect.gen(function* () {
      for (const mismatch of mismatches) {
        const candidate = {
          ...binding(readCards),
          identity: { ...binding(readCards).identity, ...mismatch },
        };
        const candidateFailure = yield* readAxisTrelloSource({ config, binding: candidate }).pipe(
          Effect.flip,
        );
        expect(candidateFailure.code).toBe("authorization");
        expect(readCards).not.toHaveBeenCalled();
      }
    });
  });

  it.effect("passes opaque cursors through pagination and preserves native IDs", () => {
    const readCards = vi.fn<AxisTrelloMcpBinding["readCards"]>((input) =>
      Effect.succeed(
        input.cursor === null
          ? { cards: [{ id: "page-1", name: "First", labels: [] }], cursor: "page-2" }
          : { cards: [{ id: "page-2", name: "Second", labels: [] }], cursor: null },
      ),
    );
    return Effect.gen(function* () {
      const first = yield* readAxisTrelloSource({ config, binding: binding(readCards) });
      const second = yield* readAxisTrelloSource({
        config,
        binding: binding(readCards),
        cursor: first.cursor,
      });
      expect(first.items[0]?.nativeId).toBe("page-1");
      expect(second.items[0]?.nativeId).toBe("page-2");
      expect(readCards).toHaveBeenNthCalledWith(2, {
        boardId: "board-1",
        cursor: "page-2",
        limit: 20,
      });
    });
  });

  it.effect("rejects duplicate IDs, oversized labels/cursors, and unsafe URLs", () => {
    const run = (page: unknown, cursor?: string) =>
      readAxisTrelloSource({
        config,
        ...(cursor === undefined ? {} : { cursor }),
        binding: binding(() => Effect.succeed(page)),
      }).pipe(Effect.flip);
    return Effect.gen(function* () {
      const duplicate = yield* run({
        cards: [
          { id: "same", name: "One", labels: [] },
          { id: "same", name: "Two", labels: [] },
        ],
        cursor: null,
      });
      expect(duplicate.code).toBe("invalid-response");
      const labels = Array.from({ length: 51 }, (_, index) => ({ name: `label-${index}` }));
      const tooManyLabels = yield* run({
        cards: [{ id: "labels", name: "Too many", labels }],
        cursor: null,
      });
      expect(tooManyLabels.code).toBe("limit-exceeded");
      const unsafeUrl = yield* run({
        cards: [{ id: "url", name: "Unsafe", url: "javascript:alert(1)", labels: [] }],
        cursor: null,
      });
      expect(unsafeUrl.code).toBe("invalid-response");
      const oversizedCursor = yield* run({ cards: [], cursor: "next" }, "x".repeat(4_097));
      expect(oversizedCursor.code).toBe("configuration");
      const returnedOversizedCursor = yield* run({ cards: [], cursor: "x".repeat(4_097) });
      expect(returnedOversizedCursor.code).toBe("invalid-response");
    });
  });

  it("converts the real collection item to the legacy AxisTaskSource shape", () => {
    const item = normalizeAxisTrelloCardToWorkHubItem(
      {
        id: "card-convert",
        name: "Convert me",
        status: "Done",
        url: "https://trello.com/c/card-convert",
        labels: [{ name: "release" }],
      },
      config,
    );
    expect(toAxisTaskSource(item, config)).toEqual({
      source: {
        kind: "trello",
        cardId: "card-convert",
        url: "https://trello.com/c/card-convert",
      },
      title: "Convert me",
      status: { kind: "mapped", native: "Done", value: "done" },
      labels: ["release"],
    });
  });

  it.effect("does not mix snapshots from different source configurations", () => {
    const source = makeAxisTrelloSource();
    const readCards = () => Effect.succeed({ cards: [], cursor: "cursor" });
    return Effect.gen(function* () {
      yield* source.read({ config, binding: binding(readCards) });
      const failure = yield* source
        .retry({
          config: { ...config, boardId: "another-board" },
          binding: binding(readCards),
        })
        .pipe(Effect.flip);
      expect(failure.code).toBe("authorization");
      expect(source.getSnapshot()?.cursor).toBe("cursor");
    });
  });

  it.effect("does not let a slower concurrent read overwrite the newer snapshot", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const source = makeAxisTrelloSource();
      const readCards: AxisTrelloMcpBinding["readCards"] = (input) =>
        input.cursor === "slow"
          ? Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(
                Effect.succeed({
                  cards: [{ id: "slow", name: "Slow", labels: [] }],
                  cursor: null,
                }),
              ),
            )
          : Effect.succeed({
              cards: [{ id: "fast", name: "Fast", labels: [] }],
              cursor: null,
            });
      const slow = yield* source
        .read({ config, binding: binding(readCards), cursor: "slow" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const fast = yield* source
        .read({ config, binding: binding(readCards), cursor: "fast" })
        .pipe(Effect.forkChild);
      yield* Fiber.join(fast);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(slow);
      expect(source.getSnapshot()?.items[0]?.nativeId).toBe("fast");
    }),
  );
});
