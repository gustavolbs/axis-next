import type { AxisLearningProposal } from "@t3tools/contracts";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { summarizeProposal } from "./projectLearningModel";

export interface LearningProposalDetailProps {
  readonly proposal: AxisLearningProposal;
  readonly busy: boolean;
  readonly onApprove: (input: {
    readonly proposalId: AxisLearningProposal["id"];
    readonly commandId: string;
    readonly expectedRevision: number;
    readonly note: string | null;
  }) => void;
  readonly onActivate: (input: {
    readonly proposalId: AxisLearningProposal["id"];
    readonly targetKey: string;
    readonly versionId: string;
    readonly commandId: string;
    readonly expectedRevision: number;
  }) => void;
  readonly onRollback: (input: {
    readonly proposalId: AxisLearningProposal["id"];
    readonly targetKey: string;
    readonly versionId: string;
    readonly commandId: string;
    readonly expectedRevision: number;
  }) => void;
  readonly onDeactivate: (input: {
    readonly proposalId: AxisLearningProposal["id"];
    readonly targetKey: string;
    readonly commandId: string;
    readonly expectedRevision: number;
    readonly note: string | null;
  }) => void;
}

export function LearningProposalDetail({
  proposal,
  busy,
  onApprove,
  onActivate,
  onRollback,
  onDeactivate,
}: LearningProposalDetailProps) {
  const summary = summarizeProposal(proposal);
  const commandId = proposal.id;

  return (
    <article className="flex flex-col gap-4 rounded-lg border border-border/60 bg-card p-4">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-semibold">{proposal.title}</h3>
          <Badge variant="outline" size="sm">
            {proposal.targetKey}
          </Badge>
          <Badge variant={proposal.status === "rejected" ? "destructive" : "outline"} size="sm">
            {proposal.status}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">{summary.evidenceCount} evidence</p>
      </header>

      <section className="text-sm leading-relaxed text-foreground">
        <p>{proposal.reviewNote ?? "No rationale provided."}</p>
      </section>

      <footer className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || proposal.status !== "in-review"}
          onClick={() =>
            onApprove({
              proposalId: proposal.id,
              commandId,
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
            onActivate({
              proposalId: proposal.id,
              targetKey: proposal.targetKey,
              versionId: "pending",
              commandId,
              expectedRevision: 0,
            })
          }
        >
          Activate
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || proposal.status !== "approved" || proposal.status !== "approved"}
          onClick={() =>
            onRollback({
              proposalId: proposal.id,
              targetKey: proposal.targetKey,
              versionId: "pending",
              commandId,
              expectedRevision: 0,
            })
          }
        >
          Rollback
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            onDeactivate({
              proposalId: proposal.id,
              targetKey: proposal.targetKey,
              commandId,
              expectedRevision: 0,
              note: null,
            })
          }
        >
          Deactivate
        </Button>
      </footer>
    </article>
  );
}
