import { describe, expect, it } from "vite-plus/test";

import {
  discoverOpenCodeMcpServers,
  parseClaudeMcpList,
  parseCodexMcpList,
  parseOpenCodeMcpConfig,
  parseOpenCodeMcpList,
} from "./ProviderMcpDiscovery.ts";

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

  describe("OpenCode", () => {
    it("reads local stdio MCP servers from the native JSON config", () => {
      const raw = JSON.stringify({
        mcp: {
          filesystem: {
            type: "local",
            command: ["npx", "-y", "@modelcontextprotocol/server-filesystem"],
          },
          disabled: {
            type: "local",
            command: ["node", "server.js"],
            enabled: false,
          },
        },
      });
      expect(parseOpenCodeMcpConfig(raw)).toEqual([
        {
          name: "filesystem",
          enabled: true,
          status: "configured",
          transport: "stdio",
          target: "npx -y @modelcontextprotocol/server-filesystem",
        },
        {
          name: "disabled",
          enabled: false,
          status: "disabled",
          transport: "stdio",
          target: "node server.js",
        },
      ]);
    });

    it("reads remote MCP servers", () => {
      const raw = JSON.stringify({
        mcp: {
          "remote-api": {
            type: "remote",
            url: "https://mcp.example.com/sse",
          },
        },
      });
      expect(parseOpenCodeMcpConfig(raw)).toEqual([
        {
          name: "remote-api",
          enabled: true,
          status: "configured",
          transport: "http",
          target: "https://mcp.example.com/sse",
        },
      ]);
    });

    it("returns an empty list on malformed JSON", () => {
      expect(parseOpenCodeMcpConfig("{not json")).toEqual([]);
      expect(parseOpenCodeMcpConfig('{"mcp": "not an object"}')).toEqual([]);
    });

    it("reads servers from the CLI TUI output as a fallback", () => {
      const stdout = [
        "\u001b[36m┌  MCP Servers\u001b[0m",
        "│",
        "filesystem  ✔ connected  /repo",
        "weather    ! Needs auth  https://x.com",
        "broken     ✘ failed",
        "muted      ⏸ disabled",
        "",
      ].join("\n");
      expect(parseOpenCodeMcpList(stdout)).toEqual([
        { name: "filesystem", enabled: true, status: "connected", scope: "local" },
        { name: "weather", enabled: true, status: "authentication-required", scope: "local" },
        { name: "broken", enabled: true, status: "failed", scope: "local" },
        { name: "muted", enabled: false, status: "configured", scope: "local" },
      ]);
    });

    it("returns an empty list when no OpenCode config files exist", () => {
      expect(discoverOpenCodeMcpServers({ cwd: "/nonexistent-path-for-test-xyz" })).toEqual([]);
    });
  });
});
