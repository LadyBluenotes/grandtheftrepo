import {
  createKanbanActiveAtomFamily,
  createKanbanBoardAtomFamily,
} from "@t3tools/client-runtime/plugins/kanban";

import { connectionAtomRuntime } from "../../connection/runtime";

export const kanbanBoard = createKanbanBoardAtomFamily(connectionAtomRuntime);

export const kanbanActive = createKanbanActiveAtomFamily(connectionAtomRuntime);
