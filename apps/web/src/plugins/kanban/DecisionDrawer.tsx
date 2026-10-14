import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { KanbanDecision, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { PencilIcon, Trash2Icon } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "~/components/ui/sheet";
import { useThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { buildThreadRouteParams } from "~/threadRoutes";
import type { BoardSearch } from "./BoardPage";
import { DecisionForm } from "./DecisionForm";
import {
  DISPOSITION_BADGE,
  DISPOSITION_LABEL,
  DeleteDecisionDialog,
  REASON_KIND_LABEL,
  STATE_BADGE,
  type DecisionScope,
  type DecisionTarget,
} from "./DecisionRow";
import { decisionRef } from "./decisionList";
import { kanbanBoard, kanbanDecisions } from "./state";

/**
 * Opens an issue's panel on the board, keeping the rest of the board's view as it is. The URL
 * carries the issue's project with its slug, since slugs are unique per project only.
 */
export function useOpenBoardIssue({ environmentId, projectId }: DecisionScope) {
  const navigate = useNavigate();
  return useCallback(
    (id: string) =>
      void navigate({
        to: "/board",
        search: (previous: BoardSearch) => ({ ...previous, environmentId, projectId, issue: id }),
      }),
    [environmentId, navigate, projectId],
  );
}

/**
 * One decision in full: its alternatives, why, links, supersession and revisions, or the form that
 * edits it. It reads the project's decisions itself, so a supersession link opens any decision of
 * the project whatever list the drawer was opened from.
 */
export function DecisionDrawer({
  environmentId,
  projectId,
  target,
  onTargetChange,
  canWrite,
  onOpenIssue,
}: DecisionScope & {
  readonly target: DecisionTarget | null;
  readonly onTargetChange: (target: DecisionTarget | null) => void;
  readonly canWrite: boolean;
  /** Opens an issue's panel; the drawer closes first. */
  readonly onOpenIssue: (id: string) => void;
}) {
  // Keeps the last decision on screen while the sheet slides away, then lets its read go.
  const [shown, setShown] = useState(target);
  if (target !== null && target !== shown) setShown(target);
  const decisions = useEnvironmentQuery(
    shown === null ? null : kanbanDecisions({ environmentId, input: { projectId } }),
  );
  const decision =
    shown === null ? undefined : decisions.data?.find((d) => decisionRef(d) === shown.ref);
  const close = () => onTargetChange(null);
  return (
    <Sheet
      open={target !== null}
      onOpenChange={(open) => !open && close()}
      onOpenChangeComplete={(open) => !open && setShown(null)}
    >
      <SheetPopup side="right" className="sm:max-w-lg">
        {shown === null || decision === undefined ? (
          <SheetHeader>
            <SheetTitle>
              {decisions.error ??
                (decisions.data === null ? "Loading…" : "This decision no longer exists.")}
            </SheetTitle>
          </SheetHeader>
        ) : shown.editing ? (
          <>
            <SheetHeader>
              <SheetTitle>Edit decision</SheetTitle>
              <SheetDescription>{decisionRef(decision)}</SheetDescription>
            </SheetHeader>
            <ScrollArea className="min-h-0 flex-1">
              <div className="px-4 pb-6">
                <DecisionForm
                  key={decisionRef(decision)}
                  environmentId={environmentId}
                  projectId={projectId}
                  decision={decision}
                  onDone={() => onTargetChange({ ref: shown.ref, editing: false })}
                />
              </div>
            </ScrollArea>
          </>
        ) : (
          <DecisionDetails
            environmentId={environmentId}
            projectId={projectId}
            decision={decision}
            decisions={decisions.data ?? []}
            canWrite={canWrite}
            onTargetChange={onTargetChange}
            onOpenIssue={(id) => {
              close();
              onOpenIssue(id);
            }}
          />
        )}
      </SheetPopup>
    </Sheet>
  );
}

function DecisionDetails({
  environmentId,
  projectId,
  decision,
  decisions,
  canWrite,
  onTargetChange,
  onOpenIssue,
}: DecisionScope & {
  readonly decision: KanbanDecision;
  readonly decisions: ReadonlyArray<KanbanDecision>;
  readonly canWrite: boolean;
  readonly onTargetChange: (target: DecisionTarget | null) => void;
  readonly onOpenIssue: (id: string) => void;
}) {
  const navigate = useNavigate();
  const board = useEnvironmentQuery(kanbanBoard({ environmentId, input: { projectId } }));
  const [deleting, setDeleting] = useState(false);
  const ref = decisionRef(decision);
  const issueTitle = (id: string) => board.data?.issues.find((issue) => issue.id === id)?.title;
  const openDecision = (other: string) => onTargetChange({ ref: other, editing: false });
  const titleOf = (other: string) => decisions.find((d) => decisionRef(d) === other)?.title;
  const replacement = decision.supersededBy;
  return (
    <>
      <SheetHeader>
        <SheetTitle>{decision.title}</SheetTitle>
        <SheetDescription>
          {ref} · by {decision.by} · {formatTime(decision.at)}
        </SheetDescription>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge size="sm" variant={STATE_BADGE[decision.state]}>
            {decision.state}
          </Badge>
          {canWrite ? (
            <>
              <Button
                className="ms-auto"
                size="xs"
                variant="outline"
                onClick={() => onTargetChange({ ref, editing: true })}
              >
                <PencilIcon />
                Edit
              </Button>
              <Button size="xs" variant="destructive-outline" onClick={() => setDeleting(true)}>
                <Trash2Icon />
                Delete
              </Button>
            </>
          ) : null}
        </div>
      </SheetHeader>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-5 px-6 pb-6 text-sm">
          <Field label="Why">
            {decision.why.length > 0 ? (
              <p className="whitespace-pre-wrap">{decision.why}</p>
            ) : (
              <p className="text-muted-foreground">Not recorded.</p>
            )}
          </Field>

          <Field label="Alternatives">
            {decision.alternatives.length === 0 ? (
              <p className="text-muted-foreground">None recorded.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {decision.alternatives.map((alternative, index) => (
                  <li
                    // Alternatives have no id, and two may share a title; this list only reads them.
                    // oxlint-disable-next-line react/no-array-index-key
                    key={index}
                    className="flex flex-col gap-0.5"
                  >
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium">{alternative.title}</span>
                      <Badge size="sm" variant={DISPOSITION_BADGE[alternative.disposition]}>
                        {DISPOSITION_LABEL[alternative.disposition]}
                      </Badge>
                      <Badge size="sm" variant="outline">
                        {REASON_KIND_LABEL[alternative.reasonKind]}
                      </Badge>
                    </span>
                    {alternative.reason.length > 0 ? (
                      <span className="whitespace-pre-wrap text-muted-foreground">
                        {alternative.reason}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Field>

          {decision.reconsiderWhen === null ? null : (
            <Field label="Reconsider when">
              <p className="whitespace-pre-wrap">{decision.reconsiderWhen}</p>
            </Field>
          )}

          <Field label="Issues">
            {decision.issues.length === 0 ? (
              <p className="text-muted-foreground">None linked.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {decision.issues.map((id) => (
                  <LinkRow key={id} onOpen={() => onOpenIssue(id)} detail={id}>
                    {issueTitle(id) ?? id}
                  </LinkRow>
                ))}
              </ul>
            )}
          </Field>

          <Field label="Threads">
            {decision.threads.length === 0 ? (
              <p className="text-muted-foreground">None linked.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {decision.threads.map((threadId) => (
                  <ThreadLink
                    key={threadId}
                    environmentId={environmentId}
                    threadId={threadId}
                    onOpen={() => {
                      onTargetChange(null);
                      void navigate({
                        to: "/$environmentId/$threadId",
                        params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
                      });
                    }}
                  />
                ))}
              </ul>
            )}
          </Field>

          {replacement === null && decision.supersedes.length === 0 ? null : (
            <Field label="Supersession">
              <ul className="flex flex-col gap-1">
                {replacement === null ? null : (
                  <LinkRow onOpen={() => openDecision(replacement)} detail="replaced this">
                    {titleOf(replacement) ?? replacement}
                  </LinkRow>
                )}
                {decision.supersedes.map((other) => (
                  <LinkRow key={other} onOpen={() => openDecision(other)} detail="replaced by this">
                    {titleOf(other) ?? other}
                  </LinkRow>
                ))}
              </ul>
            </Field>
          )}

          <Field label="Revisions">
            <ul className="flex flex-col gap-1.5">
              {decision.revisions.map((revision, index) => (
                // Revisions are append-only and have no id, so a position stays the same row.
                // oxlint-disable-next-line react/no-array-index-key
                <li key={index} className="flex gap-2">
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {formatTime(revision.at)}
                  </span>
                  <span className="min-w-0 flex-1 whitespace-pre-wrap">
                    <span className="text-muted-foreground">{revision.by} · </span>
                    {revision.change}
                  </span>
                </li>
              ))}
            </ul>
          </Field>
        </div>
      </ScrollArea>
      <DeleteDecisionDialog
        environmentId={environmentId}
        projectId={projectId}
        decision={decision}
        open={deleting}
        onClose={() => setDeleting(false)}
        onDeleted={() => onTargetChange(null)}
      />
    </>
  );
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** One linked item; the whole title is the link. */
function LinkRow({
  onOpen,
  detail,
  children,
}: {
  readonly onOpen: () => void;
  readonly detail?: string;
  readonly children: ReactNode;
}) {
  return (
    <li className="flex items-center gap-2">
      <button
        type="button"
        className="min-w-0 truncate text-left hover:underline focus-visible:underline focus-visible:outline-none"
        onClick={onOpen}
      >
        {children}
      </button>
      {detail === undefined ? null : (
        <span className="shrink-0 text-xs text-muted-foreground">{detail}</span>
      )}
    </li>
  );
}

function ThreadLink({
  environmentId,
  threadId,
  onOpen,
}: Pick<DecisionScope, "environmentId"> & {
  readonly threadId: ThreadId;
  readonly onOpen: () => void;
}) {
  const shell = useThreadShell(scopeThreadRef(environmentId, threadId));
  return (
    <LinkRow onOpen={onOpen} {...(shell === null ? { detail: threadId } : {})}>
      {shell === null ? "Unknown thread" : shell.title.trim() || "Untitled thread"}
    </LinkRow>
  );
}
