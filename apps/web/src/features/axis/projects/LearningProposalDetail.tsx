import { CheckIcon, SendIcon, XIcon } from "lucide-react";

import type { AxisLearningEvidence, AxisLearningProposal } from "@t3tools/contracts";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";

function statusBadgeVariant(status: AxisLearningProposal["status"]) {
  switch (status) {
    case "approved":
      return "success" as const;
    case "rejected":
      return "error" as const;
    default:
      return "outline" as const;
  }
}

/**
 * One proposal's reason, diff, and evidence sources. Submit/approve/reject are
 * explicit, separate actions — approving never implies activation.
 */
export function LearningProposalDetail({
  proposal,
  evidenceById,
  reviewNote,
  onReviewNoteChange,
  busy,
  writesAvailable,
  onSubmit,
  onApprove,
  onReject,
}: {
  readonly proposal: AxisLearningProposal;
  readonly evidenceById: ReadonlyMap<string, AxisLearningEvidence>;
  readonly reviewNote: string;
  readonly onReviewNoteChange: (value: string) => void;
  readonly busy: boolean;
  readonly writesAvailable: boolean;
  readonly onSubmit: () => void;
  readonly onApprove: () => void;
  readonly onReject: () => void;
}) {
  return (
    <article className="rounded-lg border border-border/50 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">{proposal.title}</p>
            <Badge variant={statusBadgeVariant(proposal.status)}>{proposal.status}</Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {proposal.kind} · {proposal.targetKey}
          </p>
          <p className="mt-2 text-sm text-muted-foreground">{proposal.rationale}</p>
          <div className="mt-2 rounded border border-border/40 bg-muted/30 p-2 text-xs">
            <p className="font-medium text-muted-foreground">Sources</p>
            <ul className="mt-1 space-y-1">
              {proposal.evidenceIds.map((id) => (
                <li key={id} className="text-muted-foreground">
                  {evidenceById.get(id)?.summary ?? id}
                </li>
              ))}
            </ul>
          </div>
          {proposal.reviewNote ? (
            <p className="mt-2 text-xs text-muted-foreground">Review note: {proposal.reviewNote}</p>
          ) : null}
          {proposal.status === "in-review" ? (
            <Input
              className="mt-3"
              value={reviewNote}
              onChange={(event) => onReviewNoteChange(event.target.value)}
              placeholder="Add a review note (optional)"
              aria-label={`Review note for ${proposal.title}`}
            />
          ) : null}
        </div>
        <div className="flex shrink-0 gap-2">
          {proposal.status === "draft" ? (
            <Button size="xs" disabled={busy || !writesAvailable} onClick={onSubmit}>
              <SendIcon /> Submit
            </Button>
          ) : null}
          {proposal.status === "in-review" ? (
            <>
              <Button size="xs" disabled={busy || !writesAvailable} onClick={onApprove}>
                <CheckIcon /> Approve
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={busy || !writesAvailable}
                onClick={onReject}
              >
                <XIcon /> Reject
              </Button>
            </>
          ) : null}
        </div>
      </div>
    </article>
  );
}
