import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  LEARNING_PROVIDER_FAILURE_KINDS,
  type LearningCorrection,
  type LearningFailureKind,
  type ThreadId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { InlineButton } from "~/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useThreadShellsForProjectRefs } from "~/state/entities";
import {
  CORRECTION_WINDOWS,
  DECLARED_MODE_LABEL,
  DECLARED_MODES,
  FAILURE_KIND_LABEL,
  FAILURE_KINDS,
  correctionsWindow,
  filterCorrections,
  isCorrectionWindow,
  isDeclaredMode,
  isFailureKind,
  threadLabel,
  useLearningCorrectionDeclare,
  useLearningCorrections,
  type CorrectionWindowDays,
  type LearningScope,
  type ModeFilter,
} from "./state";
import { When } from "./When";

const modeLabel = (mode: ModeFilter | null) =>
  mode === null ? "All modes" : mode === "none" ? "No declared mode" : DECLARED_MODE_LABEL[mode];

/**
 * A correction's declared mode, or, for one without a mode that is no provider failure, a picker
 * that declares it; the next sweep counts it toward that mode's item.
 */
function ModeCell({
  correction,
  declaring,
  onDeclared,
}: {
  readonly correction: LearningCorrection;
  readonly declaring: ReturnType<typeof useLearningCorrectionDeclare>;
  readonly onDeclared: () => void;
}) {
  const { canWrite, declare } = declaring;
  const [saving, setSaving] = useState(false);
  if (correction.declaredMode !== null) return <>{DECLARED_MODE_LABEL[correction.declaredMode]}</>;
  if (!canWrite || LEARNING_PROVIDER_FAILURE_KINDS.has(correction.failureKind))
    return <span className="text-muted-foreground">—</span>;

  const apply = async (value: string | null) => {
    if (!isDeclaredMode(value)) return;
    setSaving(true);
    const result = await declare({ id: correction.id, declaredMode: value });
    setSaving(false);
    if (result._tag === "Success") {
      onDeclared();
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not declare the mode",
        description: failure instanceof Error ? failure.message : String(failure),
      }),
    );
  };

  return (
    <div className="w-40">
      <Select<string> value={null} disabled={saving} onValueChange={(value) => void apply(value)}>
        <SelectTrigger size="sm" aria-label="Declare mode">
          <SelectValue placeholder="Declare mode" />
        </SelectTrigger>
        <SelectPopup>
          {DECLARED_MODES.map((candidate) => (
            <SelectItem key={candidate} value={candidate}>
              {DECLARED_MODE_LABEL[candidate]}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

/** A project's corrections over the chosen window, narrowed by kind and declared mode. */
export function CorrectionsTable({ environmentId, projectId }: LearningScope) {
  const [days, setDays] = useState<CorrectionWindowDays>(30);
  const [kind, setKind] = useState<LearningFailureKind | null>(null);
  const [mode, setMode] = useState<ModeFilter | null>(null);
  const corrections = useLearningCorrections({ environmentId, projectId }, correctionsWindow(days));
  const declaring = useLearningCorrectionDeclare(environmentId);
  const refs = useMemo(
    () => [scopeProjectRef(environmentId, projectId)],
    [environmentId, projectId],
  );
  const threads = useThreadShellsForProjectRefs(refs);
  const titles = useMemo(
    () => new Map<ThreadId, string>(threads.map((thread) => [thread.id, threadLabel(thread)])),
    [threads],
  );
  const rows = useMemo(
    () => filterCorrections(corrections.data ?? [], { kind, mode }),
    [corrections.data, kind, mode],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-36">
          <Select<string>
            value={String(days)}
            onValueChange={(value) => {
              const next = Number(value);
              if (isCorrectionWindow(next)) setDays(next);
            }}
          >
            <SelectTrigger size="sm" aria-label="Window">
              <SelectValue>Last {days} days</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {CORRECTION_WINDOWS.map((candidate) => (
                <SelectItem key={candidate} value={String(candidate)}>
                  Last {candidate} days
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <div className="w-44">
          <Select<string>
            value={kind ?? "all"}
            onValueChange={(value) => setKind(isFailureKind(value) ? value : null)}
          >
            <SelectTrigger size="sm" aria-label="Kind">
              <SelectValue>{kind === null ? "All kinds" : FAILURE_KIND_LABEL[kind]}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="all">All kinds</SelectItem>
              {FAILURE_KINDS.map((candidate) => (
                <SelectItem key={candidate} value={candidate}>
                  {FAILURE_KIND_LABEL[candidate]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <div className="w-48">
          <Select<string>
            value={mode ?? "all"}
            onValueChange={(value) =>
              setMode(value === "none" ? "none" : isDeclaredMode(value) ? value : null)
            }
          >
            <SelectTrigger size="sm" aria-label="Mode">
              <SelectValue>{modeLabel(mode)}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="all">All modes</SelectItem>
              {DECLARED_MODES.map((candidate) => (
                <SelectItem key={candidate} value={candidate}>
                  {DECLARED_MODE_LABEL[candidate]}
                </SelectItem>
              ))}
              <SelectItem value="none">No declared mode</SelectItem>
            </SelectPopup>
          </Select>
        </div>
        <span className="text-xs text-muted-foreground">
          {rows.length === 1 ? "1 correction" : `${rows.length} corrections`}
        </span>
      </div>
      {corrections.error !== null ? (
        <p className="text-sm text-muted-foreground">{corrections.error}</p>
      ) : corrections.data !== null && rows.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No corrections</EmptyTitle>
            <EmptyDescription>
              A failed turn, a review that asked for changes or a ticket reopened after it was done
              records one here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Kind</TableHead>
              <TableHead>Mode</TableHead>
              <TableHead>Thread</TableHead>
              <TableHead>Summary</TableHead>
              <TableHead>When</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>{FAILURE_KIND_LABEL[row.failureKind]}</TableCell>
                <TableCell>
                  <ModeCell
                    correction={row}
                    declaring={declaring}
                    onDeclared={corrections.refresh}
                  />
                </TableCell>
                <TableCell>
                  <div className="max-w-56 truncate">
                    <InlineButton
                      tone="muted"
                      render={
                        <Link
                          to="/$environmentId/$threadId"
                          params={{ environmentId, threadId: row.threadId }}
                        />
                      }
                    >
                      {titles.get(row.threadId) ?? row.threadId}
                    </InlineButton>
                  </div>
                </TableCell>
                <TableCell>
                  <span className="line-clamp-2 max-w-md whitespace-normal">{row.description}</span>
                </TableCell>
                <TableCell>
                  <When at={row.createdAt} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
