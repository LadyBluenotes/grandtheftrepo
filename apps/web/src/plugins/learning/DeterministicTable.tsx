import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  DETERMINISTIC_DISMISS_REASON_MAX_LENGTH,
  DETERMINISTIC_PROPOSALS_LIMIT,
  type DeterministicDraft,
  type DeterministicProposal,
  type EnvironmentId,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button, InlineButton } from "~/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "~/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { Textarea } from "~/components/ui/textarea";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import {
  ACCEPT_EFFECT,
  FORM_LABEL,
  PROPOSAL_STATE_LABEL,
  PROPOSAL_STATE_VARIANT,
  stepText,
  useDeterministicCommands,
  useDeterministicProposals,
} from "./deterministicState";
import { Field } from "./ItemDrawer";
import { actorLabel, type LearningScope } from "./state";
import { When } from "./When";

/**
 * A project's proposals to do repeated work without a model, from the weekly review: the undecided
 * ones first, then the decided, newest first in each. A row's title opens the drawer, where a
 * person accepts or dismisses it.
 */
export function DeterministicTable({ environmentId, projectId }: LearningScope) {
  const proposals = useDeterministicProposals({ environmentId, projectId });
  const [openId, setOpenId] = useState<number | null>(null);
  const rows = proposals.data ?? [];
  const open = rows.find((row) => row.id === openId) ?? null;

  return (
    <div className="flex flex-col gap-3">
      <span className="text-xs text-muted-foreground">
        {rows.length >= DETERMINISTIC_PROPOSALS_LIMIT
          ? "Every undecided proposal, then the newest decided ones"
          : rows.length === 1
            ? "1 proposal"
            : `${rows.length} proposals`}
      </span>
      {proposals.error !== null ? (
        <p className="text-sm text-muted-foreground">{proposals.error}</p>
      ) : proposals.data !== null && rows.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No proposals</EmptyTitle>
            <EmptyDescription>
              Each week, work agents repeat in this project that a script, a prompt, a knowledge
              page, a scheduled task or new code could do without a model is drafted here, up to
              five at a time. It needs the telemetry plugin.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Repeated work</TableHead>
              <TableHead>Form</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Threads</TableHead>
              <TableHead>Tokens a week</TableHead>
              <TableHead>Proposed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <InlineButton onClick={() => setOpenId(row.id)}>
                    <span className="line-clamp-2 max-w-md whitespace-normal text-left">
                      {row.title}
                    </span>
                  </InlineButton>
                </TableCell>
                <TableCell>{FORM_LABEL[row.form]}</TableCell>
                <TableCell>
                  <Badge size="sm" variant={PROPOSAL_STATE_VARIANT[row.state]}>
                    {PROPOSAL_STATE_LABEL[row.state]}
                  </Badge>
                </TableCell>
                <TableCell>{row.threads}</TableCell>
                <TableCell>~{row.estimatedTokens.toLocaleString("en")}</TableCell>
                <TableCell>
                  <When at={row.createdAt} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Sheet open={open !== null} onOpenChange={(next) => !next && setOpenId(null)}>
        <SheetPopup side="right" className="sm:max-w-lg">
          {open === null ? null : (
            <ProposalDetails
              key={open.id}
              environmentId={environmentId}
              proposal={open}
              onChanged={proposals.refresh}
            />
          )}
        </SheetPopup>
      </Sheet>
    </div>
  );
}

function ProposalDetails({
  environmentId,
  proposal,
  onChanged,
}: {
  readonly environmentId: EnvironmentId;
  readonly proposal: DeterministicProposal;
  readonly onChanged: () => void;
}) {
  const commands = useDeterministicCommands(environmentId, proposal.draft);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const undecided = proposal.state === "waiting" || proposal.state === "pending";

  const run = async (title: string, action: () => Promise<AtomCommandResult<unknown, unknown>>) => {
    setSaving(true);
    const result = await action();
    setSaving(false);
    if (result._tag === "Success") {
      setReason("");
      onChanged();
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: failure instanceof Error ? failure.message : String(failure),
      }),
    );
  };

  return (
    <>
      <SheetHeader>
        <SheetTitle>{proposal.title}</SheetTitle>
        <SheetDescription>
          {FORM_LABEL[proposal.form]}: repeated in {proposal.threads} threads,{" "}
          {proposal.occurrences} times, about {proposal.estimatedTokens.toLocaleString("en")}{" "}
          estimated tokens in the week from {proposal.windowFrom.slice(0, 10)}.
        </SheetDescription>
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <Badge size="sm" variant={PROPOSAL_STATE_VARIANT[proposal.state]}>
            {PROPOSAL_STATE_LABEL[proposal.state]}
          </Badge>
          {proposal.decidedAt === null ? (
            <span>
              proposed <When at={proposal.createdAt} />
            </span>
          ) : (
            <span>
              by {actorLabel(proposal.decidedBy ?? "user")} <When at={proposal.decidedAt} />
            </span>
          )}
        </div>
      </SheetHeader>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-5 px-6 pb-6">
          <Field label="Steps">
            <pre className="overflow-x-auto rounded-md bg-muted p-2 text-xs">
              {proposal.steps.map(stepText).join("\n")}
            </pre>
            <InlineButton
              tone="muted"
              render={
                <Link
                  to="/$environmentId/$threadId"
                  params={{ environmentId, threadId: ThreadId.make(proposal.example.threadId) }}
                />
              }
            >
              Open an example thread
            </InlineButton>
          </Field>

          <Field label="Draft">
            {proposal.draft === null ? (
              <p className="text-sm text-muted-foreground">{proposal.waitingReason}</p>
            ) : (
              <>
                <DraftPreview
                  environmentId={environmentId}
                  projectId={proposal.projectId}
                  draft={proposal.draft}
                />
                <p className="text-sm text-muted-foreground">
                  {ACCEPT_EFFECT[proposal.draft.kind]}
                </p>
              </>
            )}
          </Field>

          {proposal.dismissReason === null ? null : (
            <Field label="Why it was dismissed">
              <p className="whitespace-pre-wrap text-sm">{proposal.dismissReason}</p>
            </Field>
          )}

          {undecided ? (
            <Field label="Decide">
              <div className="flex flex-col gap-2">
                {proposal.state === "pending" ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      disabled={!commands.canAccept || saving}
                      onClick={() =>
                        void run("Could not accept the proposal", () =>
                          commands.accept(proposal.id),
                        )
                      }
                    >
                      Accept
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      Edit the draft where it lands before relying on it.
                    </span>
                  </div>
                ) : null}
                <Textarea
                  size="sm"
                  value={reason}
                  maxLength={DETERMINISTIC_DISMISS_REASON_MAX_LENGTH}
                  disabled={!commands.canDismiss || saving}
                  placeholder="Why not, for the record"
                  aria-label="Dismiss reason"
                  onChange={(event) => setReason(event.target.value)}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="destructive-outline"
                    disabled={!commands.canDismiss || saving || reason.trim() === ""}
                    onClick={() =>
                      void run("Could not dismiss the proposal", () =>
                        commands.dismiss(proposal.id, reason.trim()),
                      )
                    }
                  >
                    Dismiss
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    It comes back only if its weekly cost doubles.
                  </span>
                </div>
              </div>
            </Field>
          ) : null}
        </div>
      </ScrollArea>
    </>
  );
}

/**
 * What accepting a draft activates, from what the draft said when it was saved, with a link to
 * where it waits: the prompt on the Prompts tab, the page on the Knowledge screen, the task in
 * scheduled tasks, the card on the board.
 */
function DraftPreview({
  environmentId,
  projectId,
  draft,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly draft: DeterministicDraft;
}) {
  switch (draft.kind) {
    case "script":
      return (
        <>
          <span className="text-sm font-medium">{draft.script.name}</span>
          <pre className="overflow-x-auto rounded-md bg-muted p-2 text-xs">
            {draft.script.command}
          </pre>
        </>
      );
    case "prompt":
      return (
        <>
          <span className="text-sm font-medium">{draft.title}</span>
          <p className="line-clamp-4 whitespace-pre-wrap text-sm">{draft.preview}</p>
          <InlineButton
            tone="muted"
            render={
              <Link
                to="/plugins/$pluginId"
                params={{ pluginId: "learning" }}
                search={{
                  machine: environmentId,
                  tab: "prompts",
                  recordId: String(draft.promptId),
                }}
              />
            }
          >
            Open the prompt
          </InlineButton>
        </>
      );
    case "knowledge":
      return (
        <>
          <span className="text-sm font-medium">{draft.title}</span>
          <code className="text-xs">{draft.key}</code>
          <InlineButton
            tone="muted"
            render={
              <Link
                to="/plugins/$pluginId"
                params={{ pluginId: "knowledge" }}
                search={{ machine: environmentId, projectId }}
              />
            }
          >
            Open Knowledge
          </InlineButton>
        </>
      );
    case "scheduled_task":
      return (
        <>
          <span className="text-sm font-medium">{draft.title}</span>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 text-xs">
            {draft.prompt}
          </pre>
          <InlineButton
            tone="muted"
            render={
              <Link
                to="/settings/scheduled-tasks"
                search={{ environmentId, taskId: draft.taskId }}
              />
            }
          >
            Open the task
          </InlineButton>
        </>
      );
    case "kanban":
      return (
        <>
          <span className="text-sm font-medium">{draft.title}</span>
          <InlineButton
            tone="muted"
            render={
              <Link to="/board" search={{ environmentId, projectId, issue: draft.issueId }} />
            }
          >
            Open the card
          </InlineButton>
        </>
      );
  }
}
