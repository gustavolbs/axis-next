import { useState } from "react";

import type { AxisWorkHubCollectionPolicy, AxisWorkHubSource } from "@t3tools/contracts";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Textarea } from "../ui/textarea";

interface WorkHubSourceSettingsDialogProps {
  readonly source: AxisWorkHubSource | null;
  readonly mcpName: string;
  readonly open: boolean;
  readonly saving: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSave: (input: {
    readonly source: AxisWorkHubSource;
    readonly collectionPolicy: AxisWorkHubCollectionPolicy;
  }) => Promise<boolean>;
}

function WorkHubSourceSettingsDialogContent({
  source,
  mcpName,
  open,
  saving,
  onOpenChange,
  onSave,
}: WorkHubSourceSettingsDialogProps) {
  const [sourcePrompt, setSourcePrompt] = useState(source?.collectionPolicy.prompt ?? "");

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !saving && onOpenChange(nextOpen)}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{mcpName} collection</DialogTitle>
          <DialogDescription>
            Control what this MCP contributes to Work Hub, including the instructions used for this
            source.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-5">
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Prompt for this source</span>
            <Textarea
              value={sourcePrompt}
              rows={4}
              maxLength={100_000}
              placeholder="Describe exactly which items this source should find."
              onChange={(event) => setSourcePrompt(event.currentTarget.value)}
            />
          </label>
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={saving}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={saving || source === null}
            onClick={() => {
              if (!source) return;
              void onSave({
                source,
                collectionPolicy: {
                  prompt: sourcePrompt.trim(),
                },
              }).then((saved) => saved && onOpenChange(false));
            }}
          >
            {saving ? "Saving…" : "Save collection"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function WorkHubSourceSettingsDialog(props: WorkHubSourceSettingsDialogProps) {
  // Recreate the draft whenever another source is opened instead of synchronously
  // copying props into state from an effect.
  return (
    <WorkHubSourceSettingsDialogContent
      key={`${props.source?.id ?? "none"}:${props.open ? "open" : "closed"}`}
      {...props}
    />
  );
}
