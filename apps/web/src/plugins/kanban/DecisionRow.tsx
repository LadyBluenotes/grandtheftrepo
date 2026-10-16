import type {
  EnvironmentId,
  KanbanAlternativeDisposition,
  KanbanAlternativeReasonKind,
  KanbanDecision,
  KanbanDecisionState,
  ProjectId,
} from "@t3tools/contracts";
import { MoreHorizontalIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { useAtomCommand } from "~/state/use-atom-command";
import { reportFailure } from "./BoardPage";
import { chosenAlternative } from "./decisionList";
import { kanbanWrite } from "./state";

export interface DecisionScope {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

/** What the drawer shows: one decision, by `<category>/<id>`, to read or to edit. */
export interface DecisionTarget {
  readonly ref: string;
  readonly editing: boolean;
}

export const STATE_BADGE = {
  proposed: "info",
  accepted: "success",
  rejected: "error",
  deferred: "secondary",
  conflicted: "warning",
  superseded: "outline",
} as const satisfies Record<KanbanDecisionState, string>;

export const DISPOSITION_LABEL: Record<KanbanAlternativeDisposition, string> = {
  chosen: "Chosen",
  rejected: "Rejected",
  deferred: "Deferred",
  unverified: "Unverified",
  out_of_scope: "Out of scope",
};

export const DISPOSITION_BADGE = {
  chosen: "success",
  rejected: "error",
  deferred: "secondary",
  unverified: "warning",
  out_of_scope: "outline",
} as const satisfies Record<KanbanAlternativeDisposition, string>;

export const REASON_KIND_LABEL: Record<KanbanAlternativeReasonKind, string> = {
  permanent: "Holds for good",
  contextual: "Holds for now",
  lack_of_evidence: "Lacks evidence",
};

/** One decision, dense: title, state, the option it went with, and when to look again. */
export function DecisionRow({
  environmentId,
  projectId,
  decision,
  canWrite,
  onOpen,
}: DecisionScope & {
  readonly decision: KanbanDecision;
  readonly canWrite: boolean;
  /** Opens the drawer on this decision, in the form when `editing`. */
  readonly onOpen: (editing: boolean) => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const chosen = chosenAlternative(decision);
  return (
    <li className="flex items-start gap-1 rounded-lg border border-border/60 text-sm hover:border-ring/40">
      <button
        type="button"
        className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-lg px-3 py-2 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none"
        onClick={() => onOpen(false)}
      >
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-medium">{decision.title}</span>
          <Badge size="sm" variant={STATE_BADGE[decision.state]}>
            {decision.state}
          </Badge>
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {decision.category}
          {chosen === undefined ? "" : ` · Chose ${chosen.title}`}
        </span>
        {decision.reconsiderWhen === null ? null : (
          <span className="truncate text-xs text-muted-foreground">
            Reconsider when {decision.reconsiderWhen}
          </span>
        )}
      </button>
      {canWrite ? (
        <Menu>
          <MenuTrigger
            render={
              <Button
                className="mt-1.5 me-1.5"
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Actions for ${decision.title}`}
              />
            }
          >
            <MoreHorizontalIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => onOpen(true)}>
              <PencilIcon />
              Edit
            </MenuItem>
            <MenuSeparator />
            <MenuItem variant="destructive" onClick={() => setDeleting(true)}>
              <Trash2Icon />
              Delete
            </MenuItem>
          </MenuPopup>
        </Menu>
      ) : null}
      <DeleteDecisionDialog
        environmentId={environmentId}
        projectId={projectId}
        decision={decision}
        open={deleting}
        onClose={() => setDeleting(false)}
      />
    </li>
  );
}

/**
 * Asks before a decision is deleted, since nothing brings it back. A decision linked by
 * supersession cannot be deleted, so the dialog says how to unlink it instead.
 */
export function DeleteDecisionDialog({
  environmentId,
  projectId,
  decision,
  open,
  onClose,
  onDeleted,
}: DecisionScope & {
  readonly decision: KanbanDecision;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onDeleted?: () => void;
}) {
  const write = useAtomCommand(kanbanWrite, { reportFailure: false });
  const linked = decision.supersededBy !== null || decision.supersedes.length > 0;
  const remove = async () => {
    onClose();
    const result = await write({
      environmentId,
      input: { projectId, action: "decision.delete", category: decision.category, id: decision.id },
    });
    reportFailure("Could not delete the decision", result);
    if (result._tag === "Success") onDeleted?.();
  };
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onClose()}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{decision.title}”?</AlertDialogTitle>
          <AlertDialogDescription>
            {linked
              ? "It is linked by supersession. Give the superseded decision another state to unlink them first."
              : "The decision and its revisions leave the project for good. To keep the record, reject or supersede it instead."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button variant="destructive" disabled={linked} onClick={() => void remove()}>
            Delete
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
