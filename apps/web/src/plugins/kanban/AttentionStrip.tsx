import { kanbanAttentionStripRows } from "@t3tools/client-runtime/plugins/kanban";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { FlagIcon, MessageCircleQuestionMarkIcon, ShieldAlertIcon } from "lucide-react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { attentionResumeTarget, boardAttentionTitle, type BoardAttentionRow } from "./state";

/**
 * Everything in the board's projects waiting on a person, above the columns, oldest first:
 * questions and permission requests agents are waiting on, and flags other plugins raised. A row
 * about a project rather than a thread names the project, or every project for a policy of the
 * whole environment, with that environment once the board spans several. There is no dismiss; a
 * row leaves once its cause clears. Hidden while nothing waits.
 */
export function AttentionStrip({
  rows: attention,
  projectLabel,
  environmentLabel,
}: {
  readonly rows: ReadonlyArray<BoardAttentionRow>;
  readonly projectLabel: (ref: ScopedProjectRef) => string | undefined;
  /** Names an environment-wide row's environment; undefined unless the board spans several. */
  readonly environmentLabel: (environmentId: EnvironmentId) => string | undefined;
}) {
  const navigate = useNavigate();
  const rows = kanbanAttentionStripRows(attention);
  if (rows.length === 0) return null;

  const resume = (row: BoardAttentionRow) => {
    const target = attentionResumeTarget(row, row);
    switch (target?.to) {
      case "/$environmentId/$threadId":
        return void navigate(target);
      case "/board":
        return void navigate(target);
      case "/plugins":
        return void navigate(target);
      case "/plugins/$pluginId":
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
        const title = boardAttentionTitle(row, projectLabel, environmentLabel);
        return (
          <Alert
            key={`${row.environmentId}:${row.id}`}
            variant={row.source === "request" ? "info" : "warning"}
          >
            <Icon />
            <AlertTitle>
              <span className="flex min-w-0 items-center gap-1.5">
                <Badge size="sm" variant="outline">
                  {row.label}
                </Badge>
                <span className="min-w-0 truncate">{title}</span>
              </span>
            </AlertTitle>
            <AlertDescription>{row.text}</AlertDescription>
            <AlertAction>
              <Button
                size="xs"
                variant="outline"
                disabled={attentionResumeTarget(row, row) === null}
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
