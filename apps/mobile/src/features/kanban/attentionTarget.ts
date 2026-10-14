import type { KanbanAttentionRow, ThreadId } from "@t3tools/contracts";

/**
 * The thread a strip row opens on mobile, or null when it stays on the board the strip sits on: a
 * row about the whole project, and a row that leads to a plugin's screen, since mobile has none.
 */
export function attentionRowThread(
  row: Pick<KanbanAttentionRow, "resumeAction" | "threadId">,
): ThreadId | null {
  return row.resumeAction.target === "plugin" ? null : row.threadId;
}
