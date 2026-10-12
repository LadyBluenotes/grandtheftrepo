import {
  KANBAN_WS_METHODS,
  KanbanError,
  type KanbanGetIssueInput,
  type KanbanListDecisionsInput,
  type KanbanSetDirectoryInput,
  type KanbanWriteInput,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as KanbanStore from "./KanbanStore.ts";

/** The RPC group needs every handler even when the plugin is off, so an inactive plugin answers with an error. */
const store = Effect.serviceOption(KanbanStore.KanbanStore).pipe(
  Effect.flatMap(
    Option.match({
      onNone: () =>
        new KanbanError({
          code: "inactive",
          message: "The kanban plugin is not active on this environment.",
        }),
      onSome: Effect.succeed,
    }),
  ),
);

/** Spread into the WebSocket handlers through `PluginHost.handlers`. */
export const handlers = {
  [KANBAN_WS_METHODS.subscribe]: ({ projectId }: { readonly projectId: ProjectId }) =>
    Stream.unwrap(Effect.map(store, (s) => s.subscribeBoard(projectId))),
  [KANBAN_WS_METHODS.getIssue]: (input: KanbanGetIssueInput) =>
    Effect.flatMap(store, (s) => s.getIssue(input)),
  [KANBAN_WS_METHODS.listDecisions]: (input: KanbanListDecisionsInput) =>
    Effect.flatMap(store, (s) => s.listDecisions(input)),
  [KANBAN_WS_METHODS.write]: ({ projectId, ...write }: KanbanWriteInput) =>
    Effect.flatMap(store, (s) => s.write(projectId, "user", write)),
  [KANBAN_WS_METHODS.setDirectory]: (input: KanbanSetDirectoryInput) =>
    Effect.flatMap(store, (s) => s.setDirectory(input)).pipe(Effect.as({})),
};
