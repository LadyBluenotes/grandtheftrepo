import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  KANBAN_FINDING_DISPOSITIONS,
  type EnvironmentId,
  type KanbanFinding,
  type KanbanFindingDisposition,
  type KanbanFindingScope,
  type KanbanFindingTruth,
  type KanbanIssueSummary,
  type ProjectId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState, type FormEvent } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useThreadShell } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { reportFailure } from "./BoardPage";
import { kanbanFindingMove, kanbanFindingReview } from "./state";

const DISPOSITION_LABEL: Record<KanbanFindingDisposition, string> = {
  open: "open",
  fix_now: "fix now",
  ticketed: "ticketed",
  accepted_risk: "accepted risk",
  duplicate: "duplicate",
  rejected: "rejected",
  wont_fix: "won't fix",
};

const DISPOSITION_VARIANT: Record<
  KanbanFindingDisposition,
  "warning" | "error" | "info" | "secondary" | "outline"
> = {
  open: "warning",
  fix_now: "error",
  ticketed: "info",
  accepted_risk: "secondary",
  duplicate: "outline",
  rejected: "outline",
  wont_fix: "outline",
};

const TRUTH_LABEL: Record<KanbanFindingTruth, string> = {
  seen: "seen",
  partially_verified: "partly verified",
  reproduced: "reproduced",
  refuted: "refuted",
  unknown: "truth unknown",
};

const SCOPE_LABEL: Record<KanbanFindingScope, string> = {
  caused_by_current_change: "caused by the change it was found in",
  pre_existing: "pre-existing",
  adjacent: "adjacent",
  unrelated: "unrelated",
  unknown: "scope unknown",
};

/** Moving to this value opens a new Triage card for the finding. */
const NEW_CARD = "";

/**
 * One finding on an issue's panel: its disposition and truth, the evidence, where it was found and
 * the latest review. Review and Move open their form in place, as a decision's Edit does.
 */
export function FindingRow({
  environmentId,
  projectId,
  issueId,
  finding,
  issues,
  canWrite,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  /** The issue the finding is on. */
  readonly issueId: string;
  readonly finding: KanbanFinding;
  /** The board's issues, the places it can move to. */
  readonly issues: ReadonlyArray<KanbanIssueSummary>;
  readonly canWrite: boolean;
}) {
  const navigate = useNavigate();
  const thread = useThreadShell(scopeThreadRef(environmentId, finding.threadId));
  const [form, setForm] = useState<"review" | "move" | null>(null);
  const toggle = (next: "review" | "move") =>
    setForm((current) => (current === next ? null : next));
  return (
    <li className="flex flex-col gap-1 rounded-lg border border-border/60 p-3 text-sm">
      <div className="flex items-start gap-2">
        <Badge size="sm" variant={DISPOSITION_VARIANT[finding.disposition]}>
          {DISPOSITION_LABEL[finding.disposition]}
        </Badge>
        <Badge size="sm" variant="outline">
          {TRUTH_LABEL[finding.truthStatus]}
        </Badge>
        <span className="min-w-0 flex-1 font-medium">{finding.title}</span>
        {canWrite ? (
          <>
            <Button size="xs" variant="ghost-muted" onClick={() => toggle("review")}>
              Review
            </Button>
            <Button size="xs" variant="ghost-muted" onClick={() => toggle("move")}>
              Move
            </Button>
          </>
        ) : null}
      </div>
      {finding.evidence.length > 0 ? (
        <p className="whitespace-pre-wrap text-muted-foreground">{finding.evidence}</p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {SCOPE_LABEL[finding.scopeRelation]} · found in{" "}
        <button
          type="button"
          className="hover:underline"
          onClick={() =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(scopeThreadRef(environmentId, finding.threadId)),
            })
          }
        >
          {thread?.title ?? finding.threadId}
        </button>{" "}
        · {new Date(finding.proposedAt).toLocaleString()}
      </p>
      {finding.review !== null ? (
        <p className="text-xs text-muted-foreground">
          {DISPOSITION_LABEL[finding.disposition]} by {finding.review.by} ·{" "}
          {new Date(finding.review.at).toLocaleString()}: {finding.review.reason}
        </p>
      ) : null}
      {form === "review" ? (
        <ReviewForm
          environmentId={environmentId}
          projectId={projectId}
          finding={finding}
          onDone={() => setForm(null)}
        />
      ) : form === "move" ? (
        <MoveForm
          environmentId={environmentId}
          projectId={projectId}
          issueId={issueId}
          finding={finding}
          issues={issues}
          onDone={() => setForm(null)}
        />
      ) : null}
    </li>
  );
}

/**
 * A form's submit that sends one request at a time: `pending` holds from the submit until the
 * request settles, and a submit meanwhile, a double click included, does nothing.
 */
function useSubmitOnce(send: () => Promise<void>) {
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      await send();
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  return { pending, submit };
}

/**
 * Sets the disposition with a reason; picking open reopens a reviewed finding. An open finding
 * starts with nothing picked and no open choice, since the server refuses open on it.
 */
function ReviewForm({
  environmentId,
  projectId,
  finding,
  onDone,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly finding: KanbanFinding;
  readonly onDone: () => void;
}) {
  const review = useAtomCommand(kanbanFindingReview, { reportFailure: false });
  const choices = KANBAN_FINDING_DISPOSITIONS.filter(
    (value) => finding.disposition !== "open" || value !== "open",
  );
  const [disposition, setDisposition] = useState<KanbanFindingDisposition | "">(
    finding.disposition === "open" ? "" : finding.disposition,
  );
  const [reason, setReason] = useState("");
  const { pending, submit } = useSubmitOnce(async () => {
    if (disposition === "") return;
    const result = await review({
      environmentId,
      input: { projectId, id: finding.id, disposition, reason: reason.trim() },
    });
    reportFailure("Could not review the finding", result);
    if (result._tag === "Success") onDone();
  });
  return (
    <form className="flex gap-2 pt-1" onSubmit={submit}>
      <Select
        value={disposition}
        disabled={pending}
        onValueChange={(value) =>
          typeof value === "string" && setDisposition(value as KanbanFindingDisposition)
        }
      >
        <SelectTrigger size="sm" className="w-36 min-w-0" aria-label="Disposition">
          <SelectValue>
            {disposition === "" ? "Decide" : DISPOSITION_LABEL[disposition]}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {choices.map((value) => (
            <SelectItem key={value} value={value}>
              {DISPOSITION_LABEL[value]}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <Input
        size="sm"
        autoFocus
        value={reason}
        placeholder="Why"
        aria-label="Reason"
        disabled={pending}
        onChange={(event) => setReason(event.target.value)}
      />
      <Button
        type="submit"
        size="sm"
        variant="outline"
        disabled={pending || disposition === "" || reason.trim().length === 0}
      >
        Save
      </Button>
    </form>
  );
}

/** Moves the finding to another card on the board, or to a new Triage card of its own. */
function MoveForm({
  environmentId,
  projectId,
  issueId,
  finding,
  issues,
  onDone,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly issueId: string;
  readonly finding: KanbanFinding;
  readonly issues: ReadonlyArray<KanbanIssueSummary>;
  readonly onDone: () => void;
}) {
  const move = useAtomCommand(kanbanFindingMove, { reportFailure: false });
  const targets = issues.filter((issue) => issue.id !== issueId && issue.archivedAt === null);
  const [target, setTarget] = useState(NEW_CARD);
  const { pending, submit } = useSubmitOnce(async () => {
    const result = await move({
      environmentId,
      input: { projectId, id: finding.id, ...(target === NEW_CARD ? {} : { issueId: target }) },
    });
    reportFailure("Could not move the finding", result);
    if (result._tag === "Success") onDone();
  });
  return (
    <form className="flex gap-2 pt-1" onSubmit={submit}>
      <Select
        value={target}
        disabled={pending}
        onValueChange={(value) => typeof value === "string" && setTarget(value)}
      >
        <SelectTrigger size="sm" className="min-w-0 flex-1" aria-label="Move to">
          <SelectValue>
            {targets.find((issue) => issue.id === target)?.title ?? "A new Triage card"}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value={NEW_CARD}>A new Triage card</SelectItem>
          {targets.map((issue) => (
            <SelectItem key={issue.id} value={issue.id}>
              {issue.title}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        Move
      </Button>
    </form>
  );
}
