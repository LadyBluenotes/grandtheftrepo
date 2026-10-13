import { KNOWLEDGE_METHODS, KnowledgeError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as PluginRpc from "../PluginRpc.ts";
import * as KnowledgeStore from "./KnowledgeStore.ts";

/** The host dispatches to these even when the plugin is off, so an inactive plugin answers with an error. */
const store = Effect.serviceOption(KnowledgeStore.KnowledgeStore).pipe(
  Effect.flatMap(
    Option.match({
      onNone: () =>
        new KnowledgeError({ code: "inactive", message: 'Plugin "knowledge" is not running.' }),
      onSome: Effect.succeed,
    }),
  ),
);

/** Merged into the host's dispatch table through `PluginHost.handlers`. A proposal over RPC is a person's. */
export const table = PluginRpc.defineHandlers(KNOWLEDGE_METHODS)({
  list: (input) => Effect.flatMap(store, (pages) => pages.list(input)),
  propose: (input) => Effect.flatMap(store, (pages) => pages.propose(input, { kind: "person" })),
  accept: (input) => Effect.flatMap(store, (pages) => pages.accept(input)),
  retire: (input) => Effect.flatMap(store, (pages) => pages.retire(input)),
  install: (input) => Effect.flatMap(store, (pages) => pages.install(input)),
  verify: (input) => Effect.flatMap(store, (pages) => pages.verify(input)),
});
