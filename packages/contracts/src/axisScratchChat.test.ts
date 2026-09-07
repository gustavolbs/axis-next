import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  AxisScratchChatDraft,
  AxisScratchChatPatch,
  AxisScratchChatSendMessageInput,
} from "./axisScratchChat.ts";

const decodeDraft = Schema.decodeUnknownSync(AxisScratchChatDraft);
const decodePatch = Schema.decodeUnknownSync(AxisScratchChatPatch);
const decodeSendMessageInput = Schema.decodeUnknownSync(AxisScratchChatSendMessageInput);

describe("AxisScratchChat", () => {
  it("decodes a minimal draft with only the required fields", () => {
    const draft = decodeDraft({
      modelSelection: { instanceId: "codex", model: "auto" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      providerInstanceId: "codex",
    });

    expect(draft.title).toBeUndefined();
    expect(draft.contextId).toBeUndefined();
    expect(draft.providerInstanceId).toBe("codex");
    expect(draft.modelSelection.model).toBe("auto");
  });

  it("decodes a draft with optional title and contextId", () => {
    const draft = decodeDraft({
      title: "Quick question",
      contextId: "personal",
      modelSelection: { instanceId: "claude", model: "claude-opus-4-6" },
      runtimeMode: "full-access",
      interactionMode: "plan",
      providerInstanceId: "claude",
    });

    expect(draft.title).toBe("Quick question");
    expect(draft.contextId).toBe("personal");
    expect(draft.runtimeMode).toBe("full-access");
  });

  it("rejects missing provider instance id", () => {
    expect(() =>
      decodeDraft({
        modelSelection: { instanceId: "codex", model: "auto" },
        runtimeMode: "approval-required",
        interactionMode: "default",
      } as unknown),
    ).toThrow();
  });

  it("decodes a title-only patch", () => {
    const patch = decodePatch({
      id: "scratch_01HZ1234567890ABCDEFG",
      title: "Renamed chat",
    });
    expect(patch.title).toBe("Renamed chat");
  });

  it("decodes a sendMessage input with optional modelSelection override", () => {
    const input = decodeSendMessageInput({
      chatId: "scratch_01HZ1234567890ABCDEFG",
      text: "Hello there",
      modelSelection: { instanceId: "claude", model: "claude-sonnet-4-5" },
    });
    expect(input.text).toBe("Hello there");
    expect(input.modelSelection?.instanceId).toBe("claude");
  });

  it("decodes a sendMessage input without modelSelection", () => {
    const input = decodeSendMessageInput({
      chatId: "scratch_01HZ1234567890ABCDEFG",
      text: "Hi",
    });
    expect(input.modelSelection).toBeUndefined();
  });
});
