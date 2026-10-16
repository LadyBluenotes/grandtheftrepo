import type { KanbanStop } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as Readiness from "../Readiness.ts";
import * as KanbanStore from "./KanbanStore.ts";
import * as StopGate from "./StopGate.ts";

const DIRECTORY: Readiness.Check = { id: "directory", label: "Issue directory", target: "board" };
const STOP: Readiness.Check = { id: "stop", label: "Emergency stop", target: "board" };

/** The project's `issues/` folder, which the board creates the first time it opens. */
export const directoryCheck = (directory: string, state: "writable" | "missing" | "read_only") =>
  state === "writable"
    ? Readiness.ready(DIRECTORY, `The board keeps its issues in ${directory}.`)
    : state === "missing"
      ? Readiness.attention(
          DIRECTORY,
          `${directory} does not exist yet; add a card for this project on the board to create it.`,
        )
      : Readiness.attention(
          DIRECTORY,
          `The server cannot write ${directory}, so the board cannot save issues.`,
        );

/** While the stop is set, no sweep and no spec drafting starts a thread. */
export const stopCheck = (stop: KanbanStop | null) =>
  stop === null
    ? Readiness.ready(STOP, "No emergency stop is set.")
    : Readiness.attention(
        STOP,
        `An emergency stop is set${stop.reason === null ? "" : ` (${stop.reason})`}, so nothing starts threads on its own; clear it on the board.`,
      );

/** Kanban's readiness: the stop for the environment, the issue folder for one project. */
export class KanbanReadiness extends Context.Service<KanbanReadiness, Readiness.Checks>()(
  "t3/plugins/kanban/readiness/KanbanReadiness",
) {}

export const layer = Layer.effect(
  KanbanReadiness,
  Effect.gen(function* () {
    const store = yield* KanbanStore.KanbanStore;
    const gate = yield* StopGate.StopGate;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const stop = gate.get.pipe(Effect.map(stopCheck), Readiness.orAttention(STOP));

    return KanbanReadiness.of({
      checks: (projectId) =>
        projectId === null
          ? Effect.all([stop])
          : Effect.all([
              Effect.gen(function* () {
                const issues = path.join(yield* store.directory(projectId), "issues");
                if (!(yield* fs.exists(issues))) return directoryCheck(issues, "missing");
                const writable = yield* fs.access(issues, { writable: true }).pipe(
                  Effect.as(true),
                  Effect.orElseSucceed(() => false),
                );
                return directoryCheck(issues, writable ? "writable" : "read_only");
              }).pipe(Readiness.orAttention(DIRECTORY)),
              stop,
            ]),
    });
  }),
);
