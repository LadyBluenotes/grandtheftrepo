import {
  createKanbanActiveAtomFamily,
  createKanbanAttentionAtomFamily,
  createKanbanBoardAtomFamily,
} from "@t3tools/client-runtime/plugins/kanban";

import { connectionAtomRuntime } from "../../connection/runtime";
import { environmentThreadShells } from "../../state/threads";

export const kanbanBoard = createKanbanBoardAtomFamily(connectionAtomRuntime);

export const kanbanActive = createKanbanActiveAtomFamily(connectionAtomRuntime);

/**
 * What waits on a person in a project. It re-reads with the board and when a project thread's
 * pending request starts or ends, and `AttentionStrip` re-reads it when its screen is focused
 * again. Nothing polls.
 */
export const kanbanAttention = createKanbanAttentionAtomFamily(connectionAtomRuntime, {
  board: kanbanBoard,
  threadShells: environmentThreadShells.threadShellsForProjectRefsAtom,
});
