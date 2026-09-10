import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  AxisProjectContextPreviewInput,
  AxisProjectContextPreviewResult,
} from "./axisProjectContextPreview.ts";

const decodeInput = Schema.decodeUnknownEffect(AxisProjectContextPreviewInput);
const decodeResult = Schema.decodeUnknownEffect(AxisProjectContextPreviewResult);

it.effect("decodes bounded preview selection without accepting effective rules", () =>
  Effect.gen(function* () {
    const input = yield* decodeInput({
      scope: {
        contextId: "company",
        project: { environmentId: "env", projectId: "project" },
      },
      provider: { environmentId: "env", instanceId: "codex" },
      model: "gpt-5.6-sol",
      step: "verify",
      paths: ["apps/server/src/ws.ts"],
    });
    assert.equal(input.step, "verify");
    assert.equal("rules" in input, false);

    const result = yield* decodeResult({
      ...input,
      profileRevision: 3,
      rules: [],
      sources: ["project-profile"],
      learningVersionIds: [],
      conflicts: [],
      digest: "sha256:preview",
    });
    assert.equal(result.profileRevision, 3);
  }),
);
