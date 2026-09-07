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
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";

interface WorkHubSourceSettingsDialogProps {
  readonly source: AxisWorkHubSource | null;
  readonly mcpName: string;
  readonly open: boolean;
  readonly saving: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSave: (input: {
    readonly source: AxisWorkHubSource;
    readonly cacheTtlSeconds: number;
    readonly collectionPolicy: AxisWorkHubCollectionPolicy;
  }) => Promise<boolean>;
}

function CollectionToggle({
  checked,
  label,
  description,
  onCheckedChange,
}: {
  readonly checked: boolean;
  readonly label: string;
  readonly description: string;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-start justify-between gap-4 rounded-lg border border-border/65 p-3">
      <span>
        <span className="block text-sm font-medium text-foreground">{label}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
      </span>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </label>
  );
}

function WorkHubSourceSettingsDialogContent({
  source,
  mcpName,
  open,
  saving,
  onOpenChange,
  onSave,
}: WorkHubSourceSettingsDialogProps) {
  const [calendarLookbackDays, setCalendarLookbackDays] = useState(
    source?.collectionPolicy.calendarLookbackDays ?? 60,
  );
  const [calendarLookaheadDays, setCalendarLookaheadDays] = useState(
    source?.collectionPolicy.calendarLookaheadDays ?? 90,
  );
  const [cacheHours, setCacheHours] = useState((source?.cacheTtlSeconds ?? 28_800) / 3_600);
  const [assignedWorkItemsOnly, setAssignedWorkItemsOnly] = useState(
    source?.collectionPolicy.assignedWorkItemsOnly ?? true,
  );
  const [directMessages, setDirectMessages] = useState(
    source?.collectionPolicy.directMessages ?? true,
  );
  const [mentions, setMentions] = useState(source?.collectionPolicy.mentions ?? true);
  const [assignedIssueComments, setAssignedIssueComments] = useState(
    source?.collectionPolicy.assignedIssueComments ?? true,
  );

  const normalizedLookback = Math.max(0, Math.floor(calendarLookbackDays || 0));
  const normalizedLookahead = Math.max(1, Math.floor(calendarLookaheadDays || 1));
  const normalizedCacheHours = Math.max(8, Math.floor(cacheHours || 8));

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !saving && onOpenChange(nextOpen)}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{mcpName} collection</DialogTitle>
          <DialogDescription>
            Control what this MCP contributes to Work Hub and how long its result stays fresh.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Past calendar days</span>
              <Input
                nativeInput
                type="number"
                min={0}
                step={1}
                value={calendarLookbackDays}
                onChange={(event) => setCalendarLookbackDays(event.currentTarget.valueAsNumber)}
              />
            </label>
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Future calendar days</span>
              <Input
                nativeInput
                type="number"
                min={1}
                step={1}
                value={calendarLookaheadDays}
                onChange={(event) => setCalendarLookaheadDays(event.currentTarget.valueAsNumber)}
              />
            </label>
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Cache hours</span>
              <Input
                nativeInput
                type="number"
                min={8}
                step={1}
                value={cacheHours}
                onChange={(event) => setCacheHours(event.currentTarget.valueAsNumber)}
              />
            </label>
          </div>

          <div className="grid gap-2">
            <CollectionToggle
              checked={assignedWorkItemsOnly}
              label="Assigned work only"
              description="Collect Jira and task-system items assigned to the connected user."
              onCheckedChange={setAssignedWorkItemsOnly}
            />
            <CollectionToggle
              checked={directMessages}
              label="Direct messages"
              description="Include recent direct messages from supported communication MCPs."
              onCheckedChange={setDirectMessages}
            />
            <CollectionToggle
              checked={mentions}
              label="Mentions"
              description="Include recent messages that mention the connected user."
              onCheckedChange={setMentions}
            />
            <CollectionToggle
              checked={assignedIssueComments}
              label="Comments on assigned issues"
              description="Include new comments on work items assigned to the connected user."
              onCheckedChange={setAssignedIssueComments}
            />
          </div>
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
                cacheTtlSeconds: normalizedCacheHours * 3_600,
                collectionPolicy: {
                  calendarLookbackDays: normalizedLookback,
                  calendarLookaheadDays: normalizedLookahead,
                  assignedWorkItemsOnly,
                  directMessages,
                  mentions,
                  assignedIssueComments,
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
