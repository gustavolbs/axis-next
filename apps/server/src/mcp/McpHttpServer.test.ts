import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  TokenEfficiencyEngineId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { McpProtocol, McpSchema, McpServer } from "effect/unstable/ai";
import { HttpBody, HttpClient, HttpRouter, HttpServerResponse } from "effect/unstable/http";

import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import * as PreviewHandlers from "./toolkits/preview/handlers.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TokenEfficiencyMetrics from "../tokenEfficiency/TokenEfficiencyMetrics.ts";

const environmentId = EnvironmentId.make("environment-mcp-test");
const threadId = ThreadId.make("thread-mcp-test");
const tabId = PreviewTabId.make("tab-mcp-test");
const alternateTabId = PreviewTabId.make("tab-mcp-alternate");
const invocation = {
  environmentId,
  threadId,
  providerSessionId: "provider-session-mcp-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});
const TestLayer = McpHttpServer.PreviewToolkitRegistrationLive.pipe(
  Layer.provide(TokenEfficiencyMetrics.layerTest()),
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer))),
);

it("normalizes empty successful notification responses to accepted", () => {
  const notificationResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.text("", { status: 200, contentType: "application/json" }),
  );
  expect(notificationResponse.status).toBe(202);

  const resultResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: 1, result: {} }),
  );
  expect(resultResponse.status).toBe(200);
});

it.effect("compacts textual evaluate results only when the provider instance opts in", () => {
  const repeated = [
    "start",
    "npm warn deprecated transitive dependency, see the log for details",
    "npm warn deprecated transitive dependency, see the log for details",
    "npm warn deprecated transitive dependency, see the log for details",
    "npm warn deprecated transitive dependency, see the log for details",
    "done",
  ].join("\n");
  return Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const configured = yield* settings.getSettings;
    expect(configured.tokenEfficiency.mode).toBe("compress");
    const result = yield* PreviewHandlers.compactPreviewToolResult(repeated);
    const compacted = result as {
      readonly value: string;
      readonly tokenEfficiency: { readonly recoveryHandle: string };
    };
    expect(result).toMatchObject({
      tokenEfficiency: { recoveryHandle: expect.any(String) },
    });
    if (typeof result !== "object" || result === null || !("value" in result)) {
      throw new Error("expected compacted preview result metadata");
    }
    expect(compacted.value).toContain("previous line repeated");
    expect(compacted.value.length).toBeLessThan(repeated.length);
    const recoveryHandle = compacted.tokenEfficiency.recoveryHandle;
    expect(yield* PreviewHandlers.recoverPreviewToolPayload(recoveryHandle)).toBe(repeated);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerSettings.layerTest({ tokenEfficiency: { mode: "compress" } }),
        TokenEfficiencyMetrics.layerTest(),
        Layer.succeed(McpInvocationContext.McpInvocationContext, invocation),
      ),
    ),
  );
});

it.effect("uses the Axis-resolved policy over the global token-efficiency setting", () => {
  const repeated = [
    "start",
    "Axis policy line that is repeated enough to compact safely",
    "Axis policy line that is repeated enough to compact safely",
    "Axis policy line that is repeated enough to compact safely",
    "Axis policy line that is repeated enough to compact safely",
    "done",
  ].join("\n");
  return Effect.gen(function* () {
    const result = yield* PreviewHandlers.compactPreviewToolResult(repeated);
    expect(result).toMatchObject({ value: expect.stringContaining("previous line repeated") });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerSettings.layerTest({ tokenEfficiency: { mode: "off" } }),
        TokenEfficiencyMetrics.layerTest(),
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          ...invocation,
          tokenEfficiencyPolicy: {
            engine: TokenEfficiencyEngineId.make("deterministic"),
            mode: "compress",
          },
        }),
      ),
    ),
  );
});

it.effect("compacts textual snapshot fields with field-scoped recovery handles", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const repeatedLine = "repeated browser log line that is long enough to collapse";
    const repeated = ["start", repeatedLine, repeatedLine, repeatedLine, repeatedLine, "done"].join(
      "\n",
    );
    yield* Stream.runForEach(
      yield* broker.connect({
        clientId: "mcp-snapshot-compaction-client",
        environmentId,
      }),
      (event) =>
        event.type === "connected"
          ? Effect.void
          : broker.respond({
              clientId: "mcp-snapshot-compaction-client",
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ok: true,
              result: {
                url: "http://example.test/",
                title: "Example",
                loading: false,
                visibleText: repeated,
                interactiveElements: [],
                accessibilityTree: {
                  root: {
                    role: "button",
                    nodeId: "stable-node-id",
                    name: repeated,
                    text: repeated,
                    value: repeated,
                  },
                },
                consoleEntries: [{ level: "info", text: repeated, timestamp: "now" }],
                networkEntries: [],
                actionTimeline: [],
                screenshot: {
                  mimeType: "image/png",
                  data: Buffer.from("png").toString("base64"),
                  width: 10,
                  height: 5,
                },
              },
            }),
    ).pipe(Effect.forkScoped);
    yield* Effect.yieldNow;

    const result = yield* server
      .callTool({ name: "preview_snapshot", arguments: {} })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      visibleText: expect.stringContaining("previous line repeated"),
      accessibilityTree: {
        root: {
          role: "button",
          nodeId: "stable-node-id",
          name: expect.stringContaining("previous line repeated"),
          text: expect.stringContaining("previous line repeated"),
          value: repeated,
        },
      },
      tokenEfficiency: {
        fields: [
          { field: "visibleText" },
          { field: "accessibilityTree.root.name" },
          { field: "accessibilityTree.root.text" },
          { field: "consoleEntries[0].text" },
        ],
      },
    });

    const fields = (
      result.structuredContent as {
        tokenEfficiency: { fields: Array<{ field: string; applied: { recoveryHandle: string } }> };
      }
    ).tokenEfficiency.fields;
    for (const field of fields) {
      expect(yield* PreviewHandlers.recoverPreviewToolPayload(field.applied.recoveryHandle)).toBe(
        repeated,
      );
    }
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerSettings.ServerSettingsService.layerTest({ tokenEfficiency: { mode: "compress" } }),
        TestLayer,
        Layer.succeed(McpInvocationContext.McpInvocationContext, invocation),
      ),
    ),
  ),
);

it.effect("returns bounded structural preview snapshot failures", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const events = yield* broker.connect({
        clientId: "mcp-failure-client",
        environmentId,
      });
      yield* Stream.runForEach(events, (event) =>
        event.type === "connected"
          ? Effect.void
          : broker.respond({
              clientId: "mcp-failure-client",
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ok: false,
              error: {
                _tag: "PreviewAutomationExecutionError",
                message: "sensitive renderer failure",
                detail: { consoleOutput: "sensitive browser output" },
              },
            }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const snapshot = yield* server
        .callTool({ name: "preview_snapshot", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(snapshot.isError).toBe(true);
      expect(snapshot.content).toEqual([{ type: "text", text: "Preview snapshot failed." }]);
      expect(snapshot.structuredContent).toEqual({
        error: {
          _tag: "PreviewAutomationExecutionError",
          operation: "snapshot",
          failureCount: 1,
        },
      });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("terminates HTTP MCP sessions with DELETE", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const serverLayer = McpServer.layerHttp({
        name: "MCP termination test",
        version: "1.0.0",
        path: "/mcp",
        protocols: [McpProtocol.v2025_06_18],
      });
      yield* HttpRouter.serve(serverLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const httpClient = yield* HttpClient.HttpClient;

      const initializeResponse = yield* httpClient.post("/mcp", {
        headers: { accept: "application/json, text/event-stream" },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-test","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      const sessionId = initializeResponse.headers["mcp-session-id"];
      expect(initializeResponse.status).toBe(200);
      expect(sessionId).not.toBeNull();

      const missingSessionResponse = yield* httpClient.del("/mcp");
      expect(missingSessionResponse.status).toBe(400);

      const unknownSessionResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": "unknown-session" },
      });
      expect(unknownSessionResponse.status).toBe(404);

      const terminateResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": sessionId! },
      });
      expect(terminateResponse.status).toBe(204);

      const reusedSessionResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId!,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":2,"method":"ping","params":{}}`,
          "application/json",
        ),
      });
      expect(reusedSessionResponse.status).toBe(404);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("registers annotated tools and preserves authenticated request context", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const routedRequests: Array<{
        readonly operation: string;
        readonly tabId?: string | undefined;
      }> = [];
      const events = yield* broker.connect({
        clientId: "mcp-test-client",
        environmentId,
      });
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Effect.void;
        routedRequests.push(event.request);
        return broker.respond({
          clientId: "mcp-test-client",
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
          result:
            event.request.operation === "snapshot"
              ? {
                  url: "http://example.test/",
                  title: "Example",
                  loading: false,
                  visibleText: "Example",
                  interactiveElements: [],
                  accessibilityTree: {},
                  consoleEntries: [],
                  networkEntries: [],
                  actionTimeline: [],
                  screenshot: {
                    mimeType: "image/png",
                    data: Buffer.from("png").toString("base64"),
                    width: 10,
                    height: 5,
                  },
                }
              : event.request.operation === "press"
                ? undefined
                : {
                    available: true,
                    visible: true,
                    tabId,
                    url: "http://example.test/",
                    title: "Example",
                    loading: false,
                  },
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const statusTool = server.tools.find(({ tool }) => tool.name === "preview_status");
      expect(statusTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(statusTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(statusTool?.tool.annotations?.destructiveHint).toBe(false);

      const snapshotTool = server.tools.find(({ tool }) => tool.name === "preview_snapshot");
      expect(snapshotTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(snapshotTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(snapshotTool?.tool.annotations?.openWorldHint).toBe(true);

      const clickTool = server.tools.find(({ tool }) => tool.name === "preview_click");
      expect(clickTool?.tool.annotations?.readOnlyHint).toBe(false);
      expect(clickTool?.tool.annotations?.destructiveHint).toBe(true);
      expect(clickTool?.tool.annotations?.openWorldHint).toBe(true);
      expect(clickTool?.tool.outputSchema).toEqual({
        type: "object",
        additionalProperties: false,
        description: "The preview action completed successfully.",
      });

      const navigateTool = server.tools.find(({ tool }) => tool.name === "preview_navigate");
      expect(navigateTool?.tool.annotations?.destructiveHint).toBe(false);
      expect(navigateTool?.tool.annotations?.openWorldHint).toBe(true);

      expect(server.tools.some(({ tool }) => tool.name === "preview_recover")).toBe(true);

      const status = yield* server
        .callTool({ name: "preview_status", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(status.isError).toBe(false);
      expect(status.structuredContent).toMatchObject({
        available: true,
        tabId,
      });

      const malformed = yield* server
        .callTool({ name: "preview_click", arguments: { selector: "" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.flip,
        );
      expect(malformed._tag).toBe("InvalidParams");

      const snapshot = yield* server
        .callTool({ name: "preview_snapshot", arguments: { tabId: alternateTabId } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(snapshot.isError).toBe(false);
      expect(snapshot.content.some((content) => content.type === "image")).toBe(true);
      expect(snapshot.structuredContent).toMatchObject({
        screenshot: { mimeType: "image/png", width: 10, height: 5 },
      });
      expect(routedRequests.find(({ operation }) => operation === "snapshot")?.tabId).toBe(
        alternateTabId,
      );

      const actionRequests = [
        { name: "preview_click", arguments: { x: 10, y: 10 } },
        { name: "preview_type", arguments: { text: "Hello" } },
        { name: "preview_press", arguments: { key: "Enter" } },
        { name: "preview_scroll", arguments: { deltaY: 100 } },
        { name: "preview_wait_for", arguments: { text: "Example" } },
      ];
      for (const request of actionRequests) {
        const result = yield* server
          .callTool(request)
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        expect(result.isError).toBe(false);
        expect(result.structuredContent).toEqual({});
        expect(result.content).toEqual([{ type: "text", text: "{}" }]);
      }
    }),
  ).pipe(Effect.provide(TestLayer)),
);
