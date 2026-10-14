import { createFileRoute } from "@tanstack/react-router";

import { BoardPage } from "../plugins/kanban/BoardPage";
import { validateBoardSearch } from "../plugins/kanban/state";

// Plugin seam: the kanban plugin's only route. Its screens live in `plugins/kanban`.
export const Route = createFileRoute("/_chat/board")({
  validateSearch: validateBoardSearch,
  component: BoardRoute,
});

function BoardRoute() {
  return <BoardPage search={Route.useSearch()} />;
}
