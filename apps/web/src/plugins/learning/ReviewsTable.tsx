import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { Badge } from "~/components/ui/badge";
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
  DECLARED_MODE_LABEL,
  REQUEST_STATUS_LABEL,
  REQUEST_STATUS_VARIANT,
  REVIEW_OUTCOME_LABEL,
  REVIEW_OUTCOME_VARIANT,
  newestFirst,
  threadLabel,
  threadsByActivity,
  useReviewRequests,
  useReviewVerdicts,
  type LearningScope,
} from "./state";
import { When } from "./When";

/** One thread's verdicts and review requests, for any thread of the project. */
export function ReviewsTable({ environmentId, projectId }: LearningScope) {
  const refs = useMemo(
    () => [scopeProjectRef(environmentId, projectId)],
    [environmentId, projectId],
  );
  const shells = useThreadShellsForProjectRefs(refs);
  const threads = useMemo(() => threadsByActivity(shells), [shells]);
  const [threadId, setThreadId] = useState<ThreadId | null>(null);
  const selected = threads.find((thread) => thread.id === threadId) ?? threads[0];
  const verdicts = useReviewVerdicts(environmentId, selected?.id ?? null);
  const requests = useReviewRequests(environmentId, selected?.id ?? null);
  const verdictRows = useMemo(
    () => newestFirst(verdicts.data ?? [], (verdict) => verdict.createdAt),
    [verdicts.data],
  );
  const requestRows = useMemo(
    () => newestFirst(requests.data ?? [], (request) => request.requestedAt),
    [requests.data],
  );

  if (selected === undefined) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No threads</EmptyTitle>
          <EmptyDescription>
            Reviews belong to a thread; this project has none yet.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-72">
          <Select<string>
            value={selected.id}
            onValueChange={(value) => {
              const next = threads.find((thread) => thread.id === value);
              if (next !== undefined) setThreadId(next.id);
            }}
          >
            <SelectTrigger size="sm" aria-label="Thread">
              <SelectValue>{threadLabel(selected)}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {threads.map((thread) => (
                <SelectItem key={thread.id} value={thread.id}>
                  {threadLabel(thread)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <InlineButton
          tone="muted"
          render={
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId, threadId: selected.id }}
            />
          }
        >
          Open thread
        </InlineButton>
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Verdicts</h2>
        {verdicts.error !== null ? (
          <p className="text-sm text-muted-foreground">{verdicts.error}</p>
        ) : verdicts.data !== null && verdictRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No reviewer has judged this thread.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Outcome</TableHead>
                <TableHead>Failure mode</TableHead>
                <TableHead>Summary</TableHead>
                <TableHead>Invalidated</TableHead>
                <TableHead>When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {verdictRows.map((verdict) => (
                <TableRow key={verdict.id}>
                  <TableCell>
                    <Badge size="sm" variant={REVIEW_OUTCOME_VARIANT[verdict.outcome]}>
                      {REVIEW_OUTCOME_LABEL[verdict.outcome]}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {verdict.failureMode === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      DECLARED_MODE_LABEL[verdict.failureMode]
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="line-clamp-2 max-w-md whitespace-normal">
                      {verdict.summary}
                    </span>
                  </TableCell>
                  <TableCell>
                    <When at={verdict.invalidatedAt} />
                  </TableCell>
                  <TableCell>
                    <When at={verdict.createdAt} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Requests</h2>
        {requests.error !== null ? (
          <p className="text-sm text-muted-foreground">{requests.error}</p>
        ) : requests.data !== null && requestRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No review has been requested.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Checkpoint</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Requested by</TableHead>
                <TableHead>When</TableHead>
                <TableHead>Stale since</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {requestRows.map((request) => (
                <TableRow key={request.id}>
                  <TableCell>
                    <code>{request.checkpointId}</code>
                  </TableCell>
                  <TableCell>
                    <Badge size="sm" variant={REQUEST_STATUS_VARIANT[request.status]}>
                      {REQUEST_STATUS_LABEL[request.status]}
                    </Badge>
                  </TableCell>
                  <TableCell>{request.requestedBy}</TableCell>
                  <TableCell>
                    <When at={request.requestedAt} />
                  </TableCell>
                  <TableCell>
                    <When at={request.staleAt} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}
