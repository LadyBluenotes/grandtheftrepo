import { KANBAN_METHODS, KANBAN_WS_METHODS, KanbanError, type ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as PluginRpc from "../PluginRpc.ts";
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

/** Merged into the host's dispatch table through `PluginHost.handlers`. */
export const table = PluginRpc.defineHandlers(KANBAN_METHODS)({
  getIssue: (input) => Effect.flatMap(store, (s) => s.getIssue(input)),
  listDecisions: (input) => Effect.flatMap(store, (s) => s.listDecisions(input)),
  write: ({ projectId, ...write }) =>
    Effect.flatMap(store, (s) => s.write(projectId, "user", write)),
  setDirectory: (input) => Effect.flatMap(store, (s) => s.setDirectory(input)).pipe(Effect.as({})),
});

/** Stream RPCs keep their own tag; spread into the WebSocket handlers through `PluginHost.handlers`. */
export const streams = {
  [KANBAN_WS_METHODS.subscribe]: ({ projectId }: { readonly projectId: ProjectId }) =>
    Stream.unwrap(Effect.map(store, (s) => s.subscribeBoard(projectId))),
};
