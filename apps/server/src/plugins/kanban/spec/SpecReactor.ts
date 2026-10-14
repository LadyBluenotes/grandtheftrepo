import type { KanbanError } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { forkParked } from "../../../serverActivation.ts";
import * as PluginReactor from "../../PluginReactor.ts";
import * as SettleCapture from "../capture/SettleCapture.ts";
import * as SpecService from "./SpecService.ts";

/**
 * `run.updated` and `thread.settled`: a drafting or capture thread's final message is read from
 * its thread once the run ends, so the stream of turn-item updates every thread produces never
 * opens a transaction here.
 */
export const handlers = (
  spec: SpecService.SpecService["Service"],
  capture: SettleCapture.SettleCapture["Service"],
) =>
  ({
    "run.updated": ({ event }) =>
      Effect.andThen(spec.finish(event.payload), capture.finish(event.payload)),
    "thread.settled": ({ event }) => capture.settled(event.payload),
  }) satisfies PluginReactor.Handlers<KanbanError>;

/**
 * The kanban plugin's one reactor. A new cursor starts at the newest event: no attempt can be
 * older than the plugin's first run, so nothing earlier is worth replaying. After activation, as
 * the reactor's own replay does, it also closes the attempts an earlier process left `running`
 * with no thread behind them.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const spec = yield* SpecService.SpecService;
    const capture = yield* SettleCapture.SettleCapture;
    // Taken while the layer builds, before activation lets commands in: an attempt stored before
    // this belongs to an earlier process, however late the forked reconciliation runs.
    const cutoff = DateTime.formatIso(yield* DateTime.now);
    yield* PluginReactor.start({
      plugin: "kanban",
      from: "now",
      handlers: handlers(spec, capture),
    });
    yield* forkParked(
      spec
        .reconcile(cutoff)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("kanban: could not reconcile spec attempts", { cause }),
          ),
        ),
    );
  }).pipe(
    // A database that cannot take the reactor's tables is a defect, not a state the plugin runs in.
    Effect.orDie,
  ),
);
