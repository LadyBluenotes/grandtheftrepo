import type { LearningItem, LearningOwnerKind, SupervisorStatus } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as PluginSupervisor from "../PluginSupervisor.ts";
import * as Readiness from "../Readiness.ts";
import * as ItemStore from "./items/ItemStore.ts";
import * as Promoter from "./Promoter.ts";

const SWEEPS: Readiness.Check = { id: "sweeps", label: "Sweeps registered", target: null };
const PROMOTERS: Readiness.Check = { id: "promoters", label: "Promoters", target: "plugin" };

/** The sweeps the plugin's layer registers, in the order a tick runs them. */
const SWEEP_NAMES = ["classify", "promote", "regressions", "outcomes", "unclassified"];

/** The five sweeps are on the supervisor's tick, and a dry run would keep them from acting. */
export const sweepsCheck = (status: Pick<SupervisorStatus, "dryRun" | "sweeps">) => {
  const registered = new Set(
    status.sweeps.filter((sweep) => sweep.plugin === "learning").map((sweep) => sweep.name),
  );
  const missing = SWEEP_NAMES.filter((name) => !registered.has(name));
  if (missing.length > 0) {
    return Readiness.attention(
      SWEEPS,
      `The ${Readiness.list(missing)} ${missing.length === 1 ? "sweep is" : "sweeps are"} not registered; restart the server.`,
    );
  }
  if (status.dryRun) {
    return Readiness.attention(
      SWEEPS,
      "The supervisor runs dry (supervisor.json), so the sweeps change nothing.",
    );
  }
  return Readiness.ready(
    SWEEPS,
    "The classify, promote, regressions, outcomes and unclassified sweeps run each tick.",
  );
};

const kindLabel = (kind: LearningOwnerKind) => kind.replaceAll("_", " ");

/** Each owner kind with a candidate needs a promoter whose plugin runs (`ownerKinds`), or its candidates wait. */
export const promotersCheck = (
  candidates: ReadonlyArray<Pick<LearningItem, "ownerKind">>,
  registered: ReadonlyArray<LearningOwnerKind>,
) => {
  const waiting = candidates.flatMap((item) =>
    item.ownerKind !== null && !registered.includes(item.ownerKind) ? [item.ownerKind] : [],
  );
  if (waiting.length === 0) {
    return Readiness.ready(
      PROMOTERS,
      candidates.length === 0
        ? "No candidate is waiting for a promoter."
        : "Every candidate's owner kind has a promoter.",
    );
  }
  const kinds = [...new Set(waiting)].map(kindLabel);
  return Readiness.attention(
    PROMOTERS,
    `${waiting.length} ${waiting.length === 1 ? "candidate" : "candidates"} for ${Readiness.list(kinds)} ${waiting.length === 1 ? "waits" : "wait"}: no running promoter takes ${kinds.length === 1 ? "that owner kind" : "those owner kinds"}.`,
  );
};

/** Learning's readiness: the sweeps for the environment, the promoters for one project. */
export class LearningReadiness extends Context.Service<LearningReadiness, Readiness.Checks>()(
  "t3/plugins/learning/readiness/LearningReadiness",
) {}

export const layer = Layer.effect(
  LearningReadiness,
  Effect.gen(function* () {
    const supervisor = yield* PluginSupervisor.PluginSupervisor;
    const items = yield* ItemStore.ItemStore;
    const promoters = yield* Promoter.PromoterRegistry;

    const sweeps = supervisor.status.pipe(Effect.map(sweepsCheck), Readiness.orAttention(SWEEPS));

    return LearningReadiness.of({
      checks: (projectId) =>
        projectId === null
          ? Effect.all([sweeps])
          : Effect.all([
              sweeps,
              Effect.all([
                items.list({ projectId, state: "candidate" }),
                promoters.ownerKinds,
              ]).pipe(
                Effect.map(([candidates, registered]) => promotersCheck(candidates, registered)),
                Readiness.orAttention(PROMOTERS),
              ),
            ]),
    });
  }),
);
