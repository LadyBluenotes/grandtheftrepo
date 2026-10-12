import type { KanbanError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as PluginReactor from "../../PluginReactor.ts";
import * as SpecService from "./SpecService.ts";

/**
 * Only `run.updated`: a drafting thread's final message is read from its thread once the run
 * ends, so the stream of turn-item updates every thread produces never opens a transaction here.
 */
export const handlers = (spec: SpecService.SpecService["Service"]) =>
  ({
    "run.updated": ({ event }) => spec.finish(event.payload),
  }) satisfies PluginReactor.Handlers<KanbanError>;

/**
 * The kanban plugin's one reactor. A new cursor starts at the newest event: no attempt can be
 * older than the plugin's first run, so nothing earlier is worth replaying.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const spec = yield* SpecService.SpecService;
    yield* PluginReactor.start({ plugin: "kanban", from: "now", handlers: handlers(spec) });
  }).pipe(
    // A database that cannot take the reactor's tables is a defect, not a state the plugin runs in.
    Effect.orDie,
  ),
);
