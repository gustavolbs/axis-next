import {
  AxisCapabilityId,
  AxisSkillDefinition,
  AxisSkillId,
  type AxisSkillPort,
} from "@t3tools/contracts";

const port = (name: string, description: string, required = true): AxisSkillPort => ({
  name,
  description,
  required,
});

const skill = (
  id: string,
  name: string,
  description: string,
  inputs: AxisSkillPort[],
  outputs: AxisSkillPort[],
  requiredCapabilities: string[],
): AxisSkillDefinition => ({
  id: AxisSkillId.make(id),
  version: "1.0.0",
  name,
  description,
  inputs,
  outputs,
  requiredCapabilities: requiredCapabilities.map((capability) => AxisCapabilityId.make(capability)),
});

/** Portable workflow vocabulary. Runtime bindings provide the actual capabilities. */
export const AXIS_WORKFLOW_SKILLS: ReadonlyArray<AxisSkillDefinition> = [
  skill(
    "intake",
    "Intake task",
    "Turn an incoming task into a bounded objective with context and acceptance criteria.",
    [
      port("taskRequest", "The task statement and any available background."),
      port("taskContext", "Relevant project and thread context.", false),
    ],
    [
      port("objective", "A concise, actionable task objective."),
      port("acceptanceCriteria", "Observable conditions that determine completion."),
      port("scope", "Included work and explicit non-goals."),
    ],
    ["task_context_read", "acceptance_criteria_write"],
  ),
  skill(
    "impact",
    "Assess impact",
    "Identify affected code, contracts, surfaces, risks, and dependencies before planning work.",
    [
      port("objective", "The bounded task objective."),
      port("acceptanceCriteria", "The task acceptance criteria."),
      port("workspace", "The project workspace to inspect."),
    ],
    [
      port("impactAssessment", "Affected areas and expected behavioral consequences."),
      port("risks", "Known risks, constraints, and open questions."),
      port("dependencies", "Required prerequisites and dependent work."),
    ],
    ["workspace_read", "task_context_read"],
  ),
  skill(
    "plan",
    "Plan implementation",
    "Convert the impact assessment into small, ordered, verifiable implementation steps.",
    [
      port("objective", "The bounded task objective."),
      port("impactAssessment", "Findings about affected areas and risks."),
      port("acceptanceCriteria", "Observable completion conditions."),
    ],
    [
      port("implementationPlan", "Ordered steps with scope and dependencies."),
      port("verificationPlan", "Focused checks and evidence expected from each step."),
    ],
    ["workspace_read", "acceptance_criteria_read"],
  ),
  skill(
    "implement",
    "Implement changes",
    "Apply the approved plan in the project workspace while preserving the task boundaries.",
    [
      port("implementationPlan", "The ordered implementation steps."),
      port("workspace", "The project workspace to modify."),
      port("acceptanceCriteria", "Observable completion conditions."),
    ],
    [
      port("changeSet", "The implemented source changes."),
      port("implementationNotes", "Decisions, limitations, and remaining questions."),
    ],
    ["workspace_read", "workspace_write"],
  ),
  skill(
    "verify",
    "Verify changes",
    "Collect evidence for the implementation, keeping test creation, test execution, and other evidence distinct.",
    [
      port("changeSet", "The source changes to verify."),
      port("verificationPlan", "The focused checks and evidence expected."),
      port("acceptanceCriteria", "Observable completion conditions."),
    ],
    [
      port("createdTests", "Tests authored or updated to cover the change."),
      port("executedTests", "Results from tests that were actually run."),
      port("otherEvidence", "Non-test evidence such as static inspection or a build result."),
      port("verificationResult", "Pass or failure findings mapped to acceptance criteria."),
    ],
    ["workspace_read", "test_authoring", "test_execution", "evidence_collection"],
  ),
  skill(
    "self-review",
    "Self-review changes",
    "Review the current change set for correctness, scope, maintainability, and unmet acceptance criteria.",
    [
      port("changeSet", "The complete current change set."),
      port("verificationResult", "Available verification findings."),
      port("acceptanceCriteria", "Observable completion conditions."),
    ],
    [
      port("reviewFindings", "Prioritized findings and required corrections."),
      port("reviewDecision", "Whether the change is ready for preparation."),
    ],
    ["workspace_read", "diff_read", "acceptance_criteria_read"],
  ),
  skill(
    "prepare-pr",
    "Prepare pull request",
    "Prepare a reviewable change proposal using the project's source, destination, and template conventions.",
    [
      port("changeSet", "The reviewed change set."),
      port("reviewDecision", "The self-review decision and findings."),
      port("source", "The project-defined source branch or revision."),
      port("destination", "The project-defined destination branch or revision."),
      port("template", "The project-defined pull request template."),
      port("authorization", "Current task-scoped authorization for preparation."),
    ],
    [
      port("pullRequestDraft", "Title, summary, validation evidence, and proposed metadata."),
      port("reviewEvidence", "The evidence attached to the proposal."),
    ],
    ["source_control_read", "pull_request_prepare"],
  ),
  skill(
    "publish",
    "Publish change",
    "Publish an approved change only when the task has current authorization for that action.",
    [
      port("pullRequestDraft", "The prepared change proposal."),
      port("source", "The project-defined source branch or revision."),
      port("destination", "The project-defined destination branch or revision."),
      port("template", "The project-defined pull request template."),
      port("authorization", "Current task-scoped authorization to publish."),
    ],
    [
      port("publication", "The published change reference and resulting state."),
      port("publicationEvidence", "Evidence that authorization and publication succeeded."),
    ],
    ["source_control_write", "pull_request_publish", "task_authorization_read"],
  ),
  skill(
    "feedback",
    "Process feedback",
    "Evaluate review or execution feedback and turn actionable items into tracked follow-up work.",
    [
      port("feedback", "Review, user, or verification feedback."),
      port("changeSet", "The change set receiving feedback."),
      port("acceptanceCriteria", "Observable completion conditions."),
    ],
    [
      port("feedbackAssessment", "Actionable findings and their disposition."),
      port("followUpActions", "Ordered corrections or explicit resolutions."),
    ],
    ["feedback_read", "task_context_write"],
  ),
  skill(
    "handoff",
    "Hand off task",
    "Package the task state, evidence, decisions, and remaining work for the next responsible actor.",
    [
      port("objective", "The bounded task objective."),
      port("acceptanceCriteria", "Observable completion conditions."),
      port("changeSet", "The current change set."),
      port("verificationResult", "Collected verification findings."),
      port("followUpActions", "Remaining corrections or explicit resolutions."),
    ],
    [
      port("handoffSummary", "A concise state and decision summary."),
      port(
        "handoffEvidence",
        "References to the available implementation and verification evidence.",
      ),
      port("remainingWork", "Unfinished work and its reason."),
    ],
    ["task_context_read", "task_context_write", "evidence_collection"],
  ),
];

export const AxisWorkflowSkills = AXIS_WORKFLOW_SKILLS;
