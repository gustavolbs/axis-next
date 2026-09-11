import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  AXIS_LEARNING_ENGINE_MAX_CANDIDATE_PROPOSALS,
  AXIS_LEARNING_ENGINE_MAX_EVIDENCE_REFS,
  AxisLearningEngineCandidateProposal,
  AxisLearningEngineOutput,
  AxisLearningEngineRequest,
  AxisLearningEngineUnavailable,
} from "./axisLearningEngine.ts";

const decodeRequest = Schema.decodeUnknownSync(AxisLearningEngineRequest);
const decodeOutput = Schema.decodeUnknownSync(AxisLearningEngineOutput);
const decodeCandidate = Schema.decodeUnknownSync(AxisLearningEngineCandidateProposal);
const decodeUnavailable = Schema.decodeUnknownSync(AxisLearningEngineUnavailable);

const request = {
  contextId: "company_a",
  scope: { contextId: "company_a", project: { environmentId: "local", projectId: "venue-sites" } },
  evidenceRefs: [
    {
      id: "evidence_1",
      contextId: "company_a",
      scope: {
        contextId: "company_a",
        project: { environmentId: "local", projectId: "venue-sites" },
      },
    },
  ],
  content: "Repeated review corrections indicate that focused verification should happen first.",
  deadlineMs: 15_000,
};

const candidate = {
  contextId: "company_a",
  scope: request.scope,
  kind: "provider-skill",
  targetKey: "skill:verify",
  title: "Verify focused changes",
  rationale: "The same review correction was observed repeatedly.",
  evidenceIds: ["evidence_1"],
  change: {
    op: "set-workflow-step",
    step: {
      id: "verify",
      title: "Focused verification",
      instruction: "Run the focused test before handoff.",
      required: true,
      order: 0,
    },
  },
};

describe("Axis learning engine contracts", () => {
  it("accepts a bounded, project-scoped request and typed candidate", () => {
    expect(decodeRequest(request)).toMatchObject({
      contextId: "company_a",
      evidenceRefs: [{ id: "evidence_1" }],
    });
    expect(decodeCandidate(candidate).change.op).toBe("set-workflow-step");
  });

  it("rejects evidence from another context or project scope", () => {
    expect(() =>
      decodeRequest({
        ...request,
        evidenceRefs: [{ ...request.evidenceRefs[0], contextId: "company_b" }],
      }),
    ).toThrow();
    expect(() =>
      decodeRequest({
        ...request,
        evidenceRefs: [
          {
            ...request.evidenceRefs[0],
            scope: {
              contextId: "company_a",
              project: { environmentId: "local", projectId: "other" },
            },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeRequest({
        ...request,
        evidenceRefs: [request.evidenceRefs[0], request.evidenceRefs[0]],
      }),
    ).toThrow();
  });

  it("bounds evidence and candidate batches and keeps no-change explicit", () => {
    const tooManyEvidenceRefs = Array.from(
      { length: AXIS_LEARNING_ENGINE_MAX_EVIDENCE_REFS + 1 },
      (_, index) => ({
        id: `evidence_${index}`,
        contextId: "company_a",
        scope: request.scope,
      }),
    );
    expect(() => decodeRequest({ ...request, evidenceRefs: tooManyEvidenceRefs })).toThrow();

    const tooManyCandidates = Array.from(
      { length: AXIS_LEARNING_ENGINE_MAX_CANDIDATE_PROPOSALS + 1 },
      (_, index) => ({ ...candidate, targetKey: `skill:verify-${index}` }),
    );
    expect(() => decodeOutput({ status: "proposals", proposals: tooManyCandidates })).toThrow();
    expect(
      decodeOutput({ status: "no-change", reason: "No repeated improvement was found." }),
    ).toEqual({
      status: "no-change",
      reason: "No repeated improvement was found.",
    });
  });

  it("keeps unavailable engine state distinct from engine errors", () => {
    expect(
      decodeUnavailable({
        status: "unavailable",
        availability: "offline",
        message: "The configured learning engine is offline.",
      }),
    ).toMatchObject({ status: "unavailable", availability: "offline" });
  });
});
