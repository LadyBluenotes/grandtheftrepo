import { useAtomValue } from "@effect/atom-react";
import type { ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ScaleIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "~/components/ui/sheet";
import { useEnvironmentQuery } from "~/state/query";
import { DecisionDrawer } from "./DecisionDrawer";
import { DecisionRow, type DecisionScope, type DecisionTarget } from "./DecisionRow";
import { decisionRef, sortDecisions } from "./decisionList";
import { kanbanActiveAtom, kanbanDecisions, kanbanThreadDecisions, kanbanWrite } from "./state";

/**
 * The thread header's count of decisions linked to the thread, shown only when there are some.
 * It opens the decisions in a drawer, each opening in full. A draft (`thread` null) has none.
 */
export function ThreadDecisions({
  thread,
  project,
}: {
  readonly thread: ScopedThreadRef | null;
  readonly project: { readonly id: ProjectId } | null;
}) {
  // Keyed by the whole scope, so moving to another thread or environment starts the drawers closed.
  return thread === null || project === null ? null : (
    <DecisionsCount
      key={`${thread.environmentId}:${thread.threadId}:${project.id}`}
      threadRef={thread}
      projectId={project.id}
    />
  );
}

function DecisionsCount({
  threadRef,
  projectId,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly projectId: ProjectId;
}) {
  const { environmentId, threadId } = threadRef;
  const active = useAtomValue(kanbanActiveAtom(environmentId));
  const linked = useEnvironmentQuery(
    active === true
      ? kanbanThreadDecisions({ environmentId, input: { projectId, thread: threadId } })
      : null,
  );
  const [open, setOpen] = useState(false);
  const count = linked.data?.length ?? 0;
  if (count === 0 && !open) return null;
  return (
    <>
      <Button size="xs" variant="ghost-muted" onClick={() => setOpen(true)}>
        <ScaleIcon />
        Decisions ({count})
      </Button>
      <ThreadDecisionsSheet
        environmentId={environmentId}
        projectId={projectId}
        threadRef={threadRef}
        open={open}
        onClose={() => {
          setOpen(false);
          // An edit in the drawer reaches the count only on its next read, so read now.
          linked.refresh();
        }}
      />
    </>
  );
}

function ThreadDecisionsSheet({
  environmentId,
  projectId,
  threadRef,
  open,
  onClose,
}: DecisionScope & {
  readonly threadRef: ScopedThreadRef;
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const navigate = useNavigate();
  // Live while open: this read follows the project's board, so an edit here shows at once.
  const decisions = useEnvironmentQuery(
    open
      ? kanbanDecisions({ environmentId, input: { projectId, thread: threadRef.threadId } })
      : null,
  );
  const canWrite = useAtomValue(kanbanWrite.permissionAtom(environmentId));
  const [target, setTarget] = useState<DecisionTarget | null>(null);
  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetPopup side="right" className="sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Decisions in this thread</SheetTitle>
          <SheetDescription>
            Made or applied here. Open one for its alternatives and history.
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <ul className="flex flex-col gap-1.5 px-4 pb-6">
            {sortDecisions(decisions.data ?? []).map((decision) => (
              <DecisionRow
                key={decisionRef(decision)}
                environmentId={environmentId}
                projectId={projectId}
                decision={decision}
                canWrite={canWrite}
                onOpen={(editing) => setTarget({ ref: decisionRef(decision), editing })}
              />
            ))}
          </ul>
        </ScrollArea>
        <DecisionDrawer
          environmentId={environmentId}
          projectId={projectId}
          target={target}
          onTargetChange={setTarget}
          canWrite={canWrite}
          onOpenIssue={(id) => {
            onClose();
            void navigate({ to: "/board", search: { environmentId, projectId, issue: id } });
          }}
        />
      </SheetPopup>
    </Sheet>
  );
}
