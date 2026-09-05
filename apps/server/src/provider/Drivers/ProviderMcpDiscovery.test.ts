import { describe, expect, it } from "vite-plus/test";

import { parseClaudeMcpList, parseCodexMcpList } from "./ProviderMcpDiscovery.ts";

describe("provider MCP discovery parsers", () => {
  it("reads Codex JSON without returning environment secrets or arguments", () => {
    expect(
      parseCodexMcpList(
        JSON.stringify([
          {
            name: "jira",
            enabled: true,
            transport: {
              type: "stdio",
              command: "npx",
              args: ["secret-argument"],
              env: { TOKEN: "secret" },
            },
            auth_status: "unsupported",
          },
          {
            name: "calendar",
            enabled: false,
            disabled_reason: "Disabled in config",
            transport: {
              type: "streamable_http",
              url: "https://user:password@example.com/mcp?token=secret",
            },
          },
        ]),
      ),
    ).toEqual([
      {
        name: "jira",
        enabled: true,
        status: "configured",
        transport: "stdio",
        target: "npx",
      },
      {
        name: "calendar",
        enabled: false,
        status: "disabled",
        transport: "streamable_http",
        target: "https://example.com/mcp",
        detail: "Disabled in config",
      },
    ]);
  });

  it("reads Claude local and claude.ai connections and their health", () => {
    expect(
      parseClaudeMcpList(`Checking MCP server health…
claude.ai Slack: https://mcp.slack.com/mcp - ✔ Connected
Jira Local: npx jira-mcp --token secret - ⏸ Pending approval
Broken: https://example.com/mcp - ✘ Failed to connect — HTTP 502
Auth: https://example.com/auth - ! Needs authentication`),
    ).toEqual([
      {
        name: "Slack",
        enabled: true,
        status: "connected",
        scope: "claude.ai",
        target: "https://mcp.slack.com/mcp",
      },
      {
        name: "Jira Local",
        enabled: false,
        status: "pending-approval",
        scope: "local",
        target: "npx",
      },
      {
        name: "Broken",
        enabled: true,
        status: "failed",
        scope: "local",
        target: "https://example.com/mcp",
        detail: "HTTP 502",
      },
      {
        name: "Auth",
        enabled: true,
        status: "authentication-required",
        scope: "local",
        target: "https://example.com/auth",
      },
    ]);
  });
});
