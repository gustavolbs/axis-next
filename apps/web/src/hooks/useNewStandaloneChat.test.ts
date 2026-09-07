import type { ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isUsableStandaloneChatProvider } from "./useNewStandaloneChat.logic";

describe("isUsableStandaloneChatProvider", () => {
  it("waits for an enabled, installed and available provider", () => {
    const base = { enabled: true, installed: true } as ServerProvider;
    expect(isUsableStandaloneChatProvider(base)).toBe(true);
    expect(isUsableStandaloneChatProvider({ ...base, enabled: false })).toBe(false);
    expect(isUsableStandaloneChatProvider({ ...base, installed: false })).toBe(false);
    expect(isUsableStandaloneChatProvider({ ...base, availability: "unavailable" })).toBe(false);
  });
});
