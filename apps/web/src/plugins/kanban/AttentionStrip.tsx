import { kanbanAttentionStripRows } from "@t3tools/client-runtime/plugins/kanban";
import type { EnvironmentId, KanbanAttentionRow, ProjectId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { FlagIcon, MessageCircleQuestionMarkIcon, ShieldAlertIcon } from "lucide-react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { useEnvironmentQuery } from "~/state/query";
import { attentionResumeTarget, kanbanAttention } from "./state";

/**
 * Everything in the project waiting on a person, above the board's columns, oldest first:
 * questions and permission requests agents are waiting on, and flags other plugins raised. There
 * is no dismiss; a row leaves once its cause clears. Hidden while nothing waits.
 */
export function AttentionStrip({
  environmentId,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const navigate = useNavigate();
  const attention = useEnvironmentQuery(kanbanAttention({ environmentId, input: { projectId } }));
  const rows = kanbanAttentionStripRows(attention.data ?? []);
  if (rows.length === 0) return null;

  const resume = (row: KanbanAttentionRow) => {
    const target = attentionResumeTarget(row, { environmentId, projectId });
    switch (target?.to) {
      case "/$environmentId/$threadId":
        return void navigate(target);
      case "/board":
        return void navigate(target);
      case "/plugins":
        return void navigate(target);
    }
  };

  return (
    <section
      aria-label="Waiting on you"
      className="flex max-h-48 shrink-0 flex-col gap-1.5 overflow-y-auto px-5 pt-3 sm:px-6"
    >
      {rows.map((row) => {
        const Icon =
          row.kind === "question"
            ? MessageCircleQuestionMarkIcon
            : row.kind === "permission"
              ? ShieldAlertIcon
              : FlagIcon;
        return (
          <Alert key={row.id} variant={row.source === "request" ? "info" : "warning"}>
            <Icon />
            <AlertTitle>
              <span className="flex min-w-0 items-center gap-1.5">
                <Badge size="sm" variant="outline">
                  {row.label}
                </Badge>
                <span className="min-w-0 truncate">{row.title}</span>
              </span>
            </AlertTitle>
            <AlertDescription>{row.text}</AlertDescription>
            <AlertAction>
              <Button
                size="xs"
                variant="outline"
                disabled={attentionResumeTarget(row, { environmentId, projectId }) === null}
                onClick={() => resume(row)}
              >
                {row.resumeAction.label}
              </Button>
            </AlertAction>
          </Alert>
        );
      })}
    </section>
  );
}
