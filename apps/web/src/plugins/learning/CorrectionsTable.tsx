import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { LearningFailureKind, ThreadId } from "@t3tools/contracts";
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
  useLearningCorrections,
  type CorrectionWindowDays,
  type LearningScope,
  type ModeFilter,
} from "./state";
import { When } from "./When";

const modeLabel = (mode: ModeFilter | null) =>
  mode === null ? "All modes" : mode === "none" ? "No declared mode" : DECLARED_MODE_LABEL[mode];

/** A project's corrections over the chosen window, narrowed by kind and declared mode. */
export function CorrectionsTable({ environmentId, projectId }: LearningScope) {
  const [days, setDays] = useState<CorrectionWindowDays>(30);
  const [kind, setKind] = useState<LearningFailureKind | null>(null);
  const [mode, setMode] = useState<ModeFilter | null>(null);
  const corrections = useLearningCorrections({ environmentId, projectId }, correctionsWindow(days));
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
                  {row.declaredMode === null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    DECLARED_MODE_LABEL[row.declaredMode]
                  )}
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
