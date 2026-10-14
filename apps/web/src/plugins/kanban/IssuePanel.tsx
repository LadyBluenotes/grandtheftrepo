import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  KANBAN_PRIORITIES,
  KANBAN_STATUSES,
  KANBAN_TIERS,
  KANBAN_VERIFICATIONS,
  type EnvironmentId,
  type KanbanDecision,
  type KanbanIssue,
  type KanbanIssueSummary,
  type KanbanLogEntry,
  type KanbanStatus,
  type KanbanTier,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { OctagonAlertIcon, PlayIcon, XIcon } from "lucide-react";
import { useState, type FormEvent } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "~/components/ui/sheet";
import { Textarea } from "~/components/ui/textarea";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { cn } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { STATUS_LABEL, labelColor, reportFailure } from "./BoardPage";
import { DecisionForm, DecisionRow } from "./DecisionsView";
import { FindingRow } from "./FindingRow";
import { ReopenDialog } from "./ReopenDialog";
import { buildIssuePrompt, kanbanDecisions, kanbanIssue, kanbanWrite } from "./state";

interface IssuePanelProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly issueId: string | null;
  readonly categories: ReadonlyArray<{ readonly category: string; readonly count: number }>;
  /** The board's issues, where a finding can move to. */
  readonly issues: ReadonlyArray<KanbanIssueSummary>;
  readonly canWrite: boolean;
  readonly onClose: () => void;
}

const HOLDING: ReadonlySet<KanbanStatus> = new Set(["triage", "inbox"]);

export function IssuePanel({
  environmentId,
  projectId,
  issueId,
  categories,
  issues,
  canWrite,
  onClose,
}: IssuePanelProps) {
  const issue = useEnvironmentQuery(
    issueId === null ? null : kanbanIssue({ environmentId, input: { projectId, id: issueId } }),
  );
  const decisions = useEnvironmentQuery(
    issueId === null
      ? null
      : kanbanDecisions({ environmentId, input: { projectId, issue: issueId } }),
  );
  return (
    <Sheet open={issueId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetPopup side="right" className="sm:max-w-lg">
        {issue.data === null ? (
          <SheetHeader>
            <SheetTitle>{issue.error ?? "Loading…"}</SheetTitle>
          </SheetHeader>
        ) : (
          <IssueDetails
            key={issue.data.id}
            environmentId={environmentId}
            projectId={projectId}
            issue={issue.data}
            decisions={decisions.data ?? []}
            categories={categories}
            issues={issues}
            canWrite={canWrite}
          />
        )}
      </SheetPopup>
    </Sheet>
  );
}

function IssueDetails({
  environmentId,
  projectId,
  issue,
  decisions,
  categories,
  issues,
  canWrite,
}: Omit<IssuePanelProps, "issueId" | "onClose"> & {
  readonly issue: KanbanIssue;
  readonly decisions: ReadonlyArray<KanbanDecision>;
}) {
  const write = useAtomCommand(kanbanWrite, { reportFailure: false });
  const navigate = useNavigate();
  const handleNewThread = useNewThreadHandler();
  const [title, setTitle] = useState(issue.title);
  const [description, setDescription] = useState(issue.description);
  const [labels, setLabels] = useState(issue.labels.join(", "));
  const [note, setNote] = useState("");
  const [blockReason, setBlockReason] = useState("");
  const [criterion, setCriterion] = useState("");
  // Null until edited, so the field shows the reason as it is now, whoever set it.
  const [noDecision, setNoDecision] = useState<string | null>(null);
  const [reopenTo, setReopenTo] = useState<KanbanStatus | null>(null);
  const [recording, setRecording] = useState(false);
  const [starting, setStarting] = useState(false);

  const change = async (input: Omit<Parameters<typeof write>[0]["input"], "projectId">) =>
    reportFailure(
      "Could not update the issue",
      await write({ environmentId, input: { projectId, ...input } }),
    );
  const update = (patch: {
    title?: string;
    description?: string;
    labels?: ReadonlyArray<string>;
    tier?: KanbanTier;
  }) => change({ action: "issue.update", id: issue.id, ...patch });
  // Leaving Done needs a reason, which the dialog collects before the move runs.
  const requestMove = (status: KanbanStatus) =>
    issue.status === "done" && status !== "done"
      ? setReopenTo(status)
      : void change({ action: "issue.move", id: issue.id, status });

  const startThread = async () => {
    setStarting(true);
    try {
      const opened = await handleNewThread(scopeProjectRef(environmentId, projectId));
      if (opened === null) return;
      useComposerDraftStore
        .getState()
        .setPrompt(opened.draftId, buildIssuePrompt(issue, decisions, categories));
      await change({ action: "issue.link", id: issue.id, threadId: opened.threadId });
    } finally {
      setStarting(false);
    }
  };

  const addNote = async (event: FormEvent) => {
    event.preventDefault();
    const text = note.trim();
    if (text.length === 0) return;
    await change({ action: "issue.note", id: issue.id, text });
    setNote("");
  };

  return (
    <>
      <SheetHeader>
        <SheetTitle className="sr-only">{issue.title}</SheetTitle>
        <SheetDescription className="sr-only">Issue details</SheetDescription>
        <Input
          aria-label="Title"
          value={title}
          disabled={!canWrite}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() =>
            title.trim() !== issue.title &&
            title.trim().length > 0 &&
            void update({ title: title.trim() })
          }
        />
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <code>{issue.id}</code>
          {issue.reopened !== null ? (
            <Badge size="sm" variant="warning">
              reopened: {issue.reopened.reason === "defect" ? "defect" : "scope change"}
            </Badge>
          ) : null}
          <span>· by {issue.createdBy}</span>
          {issue.archivedAt !== null ? (
            <Badge size="sm" variant="outline">
              archived
            </Badge>
          ) : null}
        </div>
      </SheetHeader>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 px-4 pb-6">
          <div className="grid grid-cols-2 gap-2">
            <Field label="Status">
              <Select
                value={issue.status}
                disabled={!canWrite}
                onValueChange={(status) =>
                  typeof status === "string" && requestMove(status as KanbanStatus)
                }
              >
                <SelectTrigger size="sm" aria-label="Status">
                  <SelectValue>{STATUS_LABEL[issue.status]}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {KANBAN_STATUSES.map((status) => (
                    <SelectItem key={status} value={status}>
                      {STATUS_LABEL[status]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
            <Field label="Priority">
              <Select
                value={issue.priority}
                disabled={!canWrite}
                onValueChange={(priority) =>
                  typeof priority === "string" &&
                  void change({
                    action: "issue.update",
                    id: issue.id,
                    priority: priority as KanbanIssue["priority"],
                  })
                }
              >
                <SelectTrigger size="sm" aria-label="Priority">
                  <SelectValue>{issue.priority.toUpperCase()}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {KANBAN_PRIORITIES.map((priority) => (
                    <SelectItem key={priority} value={priority}>
                      {priority.toUpperCase()}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
            <Field label="Verification">
              <Select
                value={issue.verification}
                disabled={!canWrite}
                onValueChange={(verification) =>
                  typeof verification === "string" &&
                  void change({
                    action: "issue.update",
                    id: issue.id,
                    verification: verification as KanbanIssue["verification"],
                  })
                }
              >
                <SelectTrigger size="sm" aria-label="Verification">
                  <SelectValue>{issue.verification}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {KANBAN_VERIFICATIONS.map((verification) => (
                    <SelectItem key={verification} value={verification}>
                      {verification}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
            <Field label="Tier">
              <Select
                value={issue.tier ?? ""}
                disabled={!canWrite}
                onValueChange={(tier) =>
                  typeof tier === "string" &&
                  tier.length > 0 &&
                  void update({ tier: tier as KanbanTier })
                }
              >
                <SelectTrigger size="sm" aria-label="Tier">
                  <SelectValue>{issue.tier ?? "unset"}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {KANBAN_TIERS.map((tier) => (
                    <SelectItem key={tier} value={tier}>
                      {tier}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
          </div>

          <Field label="Labels">
            <Input
              size="sm"
              value={labels}
              disabled={!canWrite}
              placeholder="auth, bug"
              onChange={(event) => setLabels(event.target.value)}
              onBlur={() => {
                const next = labels
                  .split(",")
                  .map((l) => l.trim())
                  .filter((l) => l.length > 0);
                if (next.join("\u0000") !== issue.labels.join("\u0000"))
                  void update({ labels: next });
              }}
            />
            {issue.labels.length > 0 ? (
              <div className="flex flex-wrap gap-1 pt-1">
                {issue.labels.map((label) => (
                  <Badge key={label} size="sm" variant="label" style={labelColor(label)}>
                    {label}
                  </Badge>
                ))}
              </div>
            ) : null}
          </Field>

          {issue.blocked !== null ? (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/8 p-3 text-sm">
              <OctagonAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
              <div className="min-w-0 flex-1">
                <p className="font-medium">Needs you</p>
                <p className="text-muted-foreground">{issue.blocked.reason}</p>
                <p className="text-xs text-muted-foreground">
                  {issue.blocked.by} · {formatTime(issue.blocked.at)}
                </p>
              </div>
              <Button
                size="xs"
                variant="outline"
                disabled={!canWrite}
                onClick={() => void change({ action: "issue.unblock", id: issue.id })}
              >
                Unblock
              </Button>
            </div>
          ) : (
            <form
              className="flex gap-2"
              onSubmit={async (event) => {
                event.preventDefault();
                const reason = blockReason.trim();
                if (reason.length === 0) return;
                await change({ action: "issue.block", id: issue.id, reason });
                setBlockReason("");
              }}
            >
              <Input
                size="sm"
                value={blockReason}
                disabled={!canWrite}
                placeholder="Block: what do you need to decide?"
                onChange={(event) => setBlockReason(event.target.value)}
              />
              <Button
                type="submit"
                size="sm"
                variant="outline"
                disabled={!canWrite || blockReason.trim().length === 0}
              >
                Block
              </Button>
            </form>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={
                !canWrite || starting || HOLDING.has(issue.status) || issue.archivedAt !== null
              }
              title={HOLDING.has(issue.status) ? "Move the issue to Todo first" : undefined}
              onClick={() => void startThread()}
            >
              <PlayIcon />
              Start thread
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!canWrite}
              onClick={() =>
                void change({
                  action: issue.archivedAt === null ? "issue.archive" : "issue.unarchive",
                  id: issue.id,
                })
              }
            >
              {issue.archivedAt === null ? "Archive" : "Unarchive"}
            </Button>
            {issue.archivedAt !== null ? (
              <Button
                size="sm"
                variant="destructive-outline"
                disabled={!canWrite}
                onClick={() => void change({ action: "issue.delete", id: issue.id })}
              >
                Delete
              </Button>
            ) : null}
          </div>

          <Field label="Description">
            <Textarea
              rows={6}
              value={description}
              disabled={!canWrite}
              placeholder="What is this about? Markdown."
              onChange={(event) => setDescription(event.target.value)}
              onBlur={() => description !== issue.description && void update({ description })}
            />
          </Field>

          <Field
            label={`Acceptance criteria${
              issue.criteria.length > 0
                ? ` (${issue.criteria.filter((c) => c.checked).length}/${issue.criteria.length})`
                : ""
            }`}
          >
            {issue.criteria.length > 0 ? (
              <ul className="flex flex-col gap-1.5">
                {issue.criteria.map((c) => (
                  <li key={c.id} className="flex items-start gap-2 text-sm">
                    <Checkbox
                      className="mt-0.5"
                      checked={c.checked}
                      disabled={!canWrite}
                      aria-label={c.text}
                      onCheckedChange={(checked) =>
                        void change({
                          action: "criterion.update",
                          id: issue.id,
                          criterionId: c.id,
                          checked: checked === true,
                        })
                      }
                    />
                    <span
                      className={cn(
                        "min-w-0 flex-1",
                        c.checked && "text-muted-foreground line-through",
                      )}
                    >
                      {c.text}
                    </span>
                    {canWrite ? (
                      <Button
                        size="icon-xs"
                        variant="ghost-muted"
                        aria-label="Remove criterion"
                        onClick={() =>
                          void change({
                            action: "criterion.remove",
                            id: issue.id,
                            criterionId: c.id,
                          })
                        }
                      >
                        <XIcon />
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                Nothing defines done yet. Done is refused while a criterion is open.
              </p>
            )}
            {canWrite ? (
              <form
                className="flex gap-2 pt-1"
                onSubmit={async (event) => {
                  event.preventDefault();
                  const text = criterion.trim();
                  if (text.length === 0) return;
                  await change({ action: "criterion.add", id: issue.id, text });
                  setCriterion("");
                }}
              >
                <Input
                  size="sm"
                  value={criterion}
                  placeholder="What must be true for this to be done?"
                  onChange={(event) => setCriterion(event.target.value)}
                />
                <Button
                  type="submit"
                  size="sm"
                  variant="outline"
                  disabled={criterion.trim().length === 0}
                >
                  Add
                </Button>
              </form>
            ) : null}
          </Field>

          {issue.threads.length > 0 ? (
            <Field label="Threads">
              <ul className="flex flex-col gap-1">
                {issue.threads.map((link) => (
                  <ThreadRow
                    key={link.id}
                    environmentId={environmentId}
                    threadId={link.id}
                    onOpen={() =>
                      void navigate({
                        to: "/$environmentId/$threadId",
                        params: buildThreadRouteParams(scopeThreadRef(environmentId, link.id)),
                      })
                    }
                    onUnlink={
                      canWrite
                        ? () =>
                            void change({ action: "issue.unlink", id: issue.id, threadId: link.id })
                        : undefined
                    }
                  />
                ))}
              </ul>
            </Field>
          ) : null}

          {issue.findings.length > 0 ? (
            <Field label={findingsLabel(issue)}>
              <ul className="flex flex-col gap-2">
                {issue.findings.map((finding) => (
                  <FindingRow
                    key={finding.id}
                    environmentId={environmentId}
                    projectId={projectId}
                    issueId={issue.id}
                    finding={finding}
                    issues={issues}
                    canWrite={canWrite}
                  />
                ))}
              </ul>
            </Field>
          ) : null}

          <Field
            label="Decisions"
            action={
              canWrite ? (
                <Button size="xs" variant="ghost-muted" onClick={() => setRecording((v) => !v)}>
                  {recording ? "Cancel" : "Record"}
                </Button>
              ) : undefined
            }
          >
            {recording ? (
              <DecisionForm
                environmentId={environmentId}
                projectId={projectId}
                categories={categories}
                initialIssues={[issue.id]}
                onDone={() => setRecording(false)}
              />
            ) : null}
            {decisions.length === 0 && !recording ? (
              <p className="text-sm text-muted-foreground">
                {issue.closureCheck && issue.noDecision === null
                  ? "None about this ticket. Done needs one, or a reason none was needed."
                  : "None about this ticket."}
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {decisions.map((decision) => (
                  <DecisionRow
                    key={`${decision.category}:${decision.id}`}
                    environmentId={environmentId}
                    projectId={projectId}
                    decision={decision}
                    categories={categories}
                    canWrite={canWrite}
                  />
                ))}
              </ul>
            )}
            {issue.noDecision !== null || (decisions.length === 0 && canWrite) ? (
              <Input
                size="sm"
                aria-label="Why no decision was needed"
                value={noDecision ?? issue.noDecision?.reason ?? ""}
                disabled={!canWrite}
                placeholder="No decision needed, because…"
                onChange={(event) => setNoDecision(event.target.value)}
                onBlur={() =>
                  noDecision !== null &&
                  noDecision.trim() !== (issue.noDecision?.reason ?? "") &&
                  void change({
                    action: "issue.noDecision",
                    id: issue.id,
                    reason: noDecision.trim(),
                  })
                }
              />
            ) : null}
          </Field>

          <Field label="Log">
            <ul className="flex flex-col gap-1.5 text-sm">
              {issue.log.map((entry) => (
                <LogRow key={`${entry.at}|${entry.kind}|${entry.text}`} entry={entry} />
              ))}
            </ul>
            {canWrite ? (
              <form className="flex gap-2 pt-2" onSubmit={addNote}>
                <Input
                  size="sm"
                  value={note}
                  placeholder="Add a note"
                  onChange={(event) => setNote(event.target.value)}
                />
                <Button
                  type="submit"
                  size="sm"
                  variant="outline"
                  disabled={note.trim().length === 0}
                >
                  Note
                </Button>
              </form>
            ) : null}
          </Field>
        </div>
      </ScrollArea>
      <ReopenDialog
        open={reopenTo !== null}
        onCancel={() => setReopenTo(null)}
        onPick={(reason) => {
          const status = reopenTo;
          setReopenTo(null);
          if (status !== null)
            void change({ action: "issue.move", id: issue.id, status, reopenReason: reason });
        }}
      />
    </>
  );
}

function Field({
  label,
  action,
  children,
}: {
  readonly label: string;
  readonly action?: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        {action}
      </div>
      {children}
    </div>
  );
}

function findingsLabel(issue: KanbanIssue): string {
  const open = issue.findings.filter((finding) => finding.disposition === "open").length;
  return open === 0 ? "Findings" : `Findings (${open} open)`;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function LogRow({ entry }: { readonly entry: KanbanLogEntry }) {
  return (
    <li className="flex gap-2">
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {formatTime(entry.at)}
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap">
        <span className="text-muted-foreground">{entry.by} · </span>
        {entry.kind === "status" ? (
          <>moved to {STATUS_LABEL[entry.text as KanbanStatus] ?? entry.text}</>
        ) : entry.kind === "blocked" ? (
          <>blocked: {entry.text}</>
        ) : entry.kind === "unblocked" ? (
          <>unblocked</>
        ) : entry.kind === "reopened" ? (
          <>reopened: {entry.text === "defect" ? "the work was wrong" : "the ask changed"}</>
        ) : entry.kind === "criterion" ? (
          <>criterion {entry.text}</>
        ) : entry.kind === "finding" ? (
          <>finding {entry.text}</>
        ) : entry.kind === "no_decision" ? (
          entry.text.length === 0 ? (
            <>cleared the no-decision reason</>
          ) : (
            <>no decision needed: {entry.text}</>
          )
        ) : (
          entry.text
        )}
      </span>
    </li>
  );
}

function ThreadRow({
  environmentId,
  threadId,
  onOpen,
  onUnlink,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onOpen: () => void;
  readonly onUnlink: (() => void) | undefined;
}) {
  const shell = useThreadShell(scopeThreadRef(environmentId, threadId));
  return (
    <li className="flex items-center gap-2 text-sm">
      <button
        type="button"
        className="min-w-0 flex-1 truncate text-left hover:underline"
        onClick={onOpen}
      >
        {shell?.title ?? "Draft not sent yet"}
      </button>
      {shell !== null ? (
        <Badge size="sm" variant="outline">
          {shell.runtime?.status ?? "idle"}
        </Badge>
      ) : null}
      {onUnlink !== undefined ? (
        <Button size="xs" variant="ghost-muted" onClick={onUnlink}>
          Unlink
        </Button>
      ) : null}
    </li>
  );
}
