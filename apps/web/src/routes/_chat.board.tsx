import { createFileRoute } from "@tanstack/react-router";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { BoardPage, type BoardSearch } from "../plugins/kanban/BoardPage";

// Plugin seam: the kanban plugin's only route. Its screens live in `plugins/kanban`.
export const Route = createFileRoute("/_chat/board")({
  validateSearch: (raw: Record<string, unknown>): BoardSearch => ({
    ...(typeof raw.environmentId === "string" && raw.environmentId
      ? { environmentId: raw.environmentId as EnvironmentId }
      : {}),
    ...(typeof raw.projectId === "string" && raw.projectId
      ? { projectId: raw.projectId as ProjectId }
      : {}),
    ...(typeof raw.issue === "string" && raw.issue ? { issue: raw.issue.slice(0, 80) } : {}),
    ...(raw.view === "decisions" ? { view: raw.view } : {}),
    ...(typeof raw.category === "string" && raw.category
      ? { category: raw.category.slice(0, 80) }
      : {}),
    ...(raw.needsYou === true ? { needsYou: true } : {}),
    ...(raw.archived === true ? { archived: true } : {}),
  }),
  component: BoardRoute,
});

function BoardRoute() {
  return <BoardPage search={Route.useSearch()} />;
}
