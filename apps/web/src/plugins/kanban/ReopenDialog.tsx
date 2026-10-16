import type { KanbanReopenReason } from "@t3tools/contracts";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";

/** A Done card only comes back with a reason; this asks for it. */
export function ReopenDialog({
  open,
  onPick,
  onCancel,
}: {
  readonly open: boolean;
  readonly onPick: (reason: KanbanReopenReason) => void;
  readonly onCancel: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Why is this coming back?</DialogTitle>
          <DialogDescription>
            The reason stays on the card, so the next agent knows what happened.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost-muted" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="outline" onClick={() => onPick("scope_change")}>
            The ask changed
          </Button>
          <Button onClick={() => onPick("defect")}>The work was wrong</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
