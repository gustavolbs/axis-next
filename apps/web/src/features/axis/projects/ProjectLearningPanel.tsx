import type { AxisContextProjectScope } from "@t3tools/contracts";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  type ProjectLearningActionResult,
  type ProjectLearningSnapshot,
  type ProjectLearningProposalSummary,
  summarizeProposal,
} from "./projectLearningModel";
import type { AxisLearningProposal } from "@t3tools/contracts";

export interface ProjectLearningPanelProps {
  readonly scope: AxisContextProjectScope;
  readonly snapshot: ProjectLearningSnapshot;
  readonly proposals: ReadonlyArray<AxisLearningProposal>;
  readonly busy: boolean;
  readonly onApprove: (input: {
    readonly proposalId: AxisLearningProposal["id"];
    readonly commandId: string;
    readonly expectedRevision: number;
    readonly note: string | null;
  }) => Promise<ProjectLearningActionResult> | ProjectLearningActionResult;
  readonly onActivate: (input: {
    readonly proposalId: AxisLearningProposal["id"];
    readonly commandId: string;
    readonly expectedRevision: number;
    readonly targetKey: string;
    readonly versionId: string;
  }) => Promise<ProjectLearningActionResult> | ProjectLearningActionResult;
  readonly onOpenProposal: (proposalId: AxisLearningProposal["id"]) => void;
}

export function ProjectLearningPanel({
  scope,
  snapshot,
  proposals,
  busy,
  onApprove,
  onActivate,
  onOpenProposal,
}: ProjectLearningPanelProps) {
  const items: ReadonlyArray<ProjectLearningProposalSummary> = proposals
    .filter((p) => p.contextId === scope.contextId)
    .map(summarizeProposal);

  return (
    <section className="flex flex-col gap-4" data-testid="project-learning-panel">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">Project learning</h3>
          <p className="text-xs text-muted-foreground">
            Proposals, activations and outcomes scoped to this project.
          </p>
        </div>
        <Badge variant={engineStateVariant(snapshot.engineState)} size="sm">
          Engine: {snapshot.engineState}
        </Badge>
      </header>

      {items.length === 0 ? (
        <p className="rounded-md border border-dashed border-border/60 px-3 py-4 text-sm text-muted-foreground">
          No learning proposals yet. Request an improvement run to populate this list.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((proposal) => (
            <li
              key={proposal.id}
              className="flex flex-col gap-2 rounded-md border border-border/60 bg-card px-3 py-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      {proposals.find((p) => p.id === proposal.id)?.title ?? proposal.targetKey}
                    </span>
                    <Badge variant="outline" size="sm">
                      {proposal.targetKey}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {proposal.evidenceCount} evidence · updated {proposal.updatedAt}
                  </p>
                </div>
                <Badge variant={statusVariant(proposal.status)} size="sm">
                  {proposal.status}
                </Badge>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy || proposal.status !== "in-review"}
                  onClick={() =>
                    void onApprove({
                      proposalId: proposal.id,
                      commandId: proposal.id,
                      expectedRevision: 0,
                      note: null,
                    })
                  }
                >
                  Approve
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={busy || proposal.status !== "approved"}
                  onClick={() =>
                    void onActivate({
                      proposalId: proposal.id,
                      commandId: proposal.id,
                      expectedRevision: 0,
                      targetKey: proposal.targetKey,
                      versionId: "pending",
                    })
                  }
                >
                  Activate
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => onOpenProposal(proposal.id)}
                >
                  Open
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function statusVariant(
  status: string,
): "default" | "outline" | "success" | "warning" | "destructive" {
  if (status === "active" || status === "approved") return "success";
  if (status === "in-review" || status === "draft") return "warning";
  if (status === "rejected") return "destructive";
  return "outline";
}

function engineStateVariant(state: ProjectLearningSnapshot["engineState"]) {
  if (state === "available") return "success" as const;
  if (state === "offline") return "warning" as const;
  if (state === "unconfigured") return "outline" as const;
  return "destructive" as const;
}
