import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as SqlError from "effect/sql/SqlError";
import * as KnowledgePromoter from "../knowledge/promoter.ts";
import type { ServerPlugin } from "../Plugin.ts";
import * as PluginReactor from "../PluginReactor.ts";
import * as PluginSupervisor from "../PluginSupervisor.ts";
import * as PolicyPromoter from "../policy/promoter.ts";
import * as ClassifySweep from "./ClassifySweep.ts";
import * as CorrectionStore from "./CorrectionStore.ts";
import * as ItemStore from "./items/ItemStore.ts";
import * as Mcp from "./mcp.ts";
import { migrations } from "./migrations.ts";
import * as ChangesRequested from "./producers/changesRequested.ts";
import * as Reopened from "./producers/reopened.ts";
import * as TurnFailures from "./producers/turnFailures.ts";
import * as PromoteSweep from "./PromoteSweep.ts";
import * as Promoter from "./Promoter.ts";
import * as RegressionSweep from "./regressions/RegressionSweep.ts";

/** Every producer's handlers, run by one reactor from the first event the server ever committed. */
export const handlers = {
  ...TurnFailures.handlers,
  ...ChangesRequested.handlers,
  ...Reopened.handlers,
} satisfies PluginReactor.Handlers<SqlError.SqlError>;

// None fails in a state the plugin can run in: the reactor's cursor tables go in the database
// the host just migrated, and a second sweep or promoter under this plugin's own name is a defect.
const start = Effect.gen(function* () {
  yield* PluginReactor.start({ plugin: "learning", from: "start", handlers });
  // The knowledge and policy plugins are reached when a sweep runs, so each promoter says whether
  // its plugin is there; learning depends on neither, and a plugin that is off costs nothing.
  const promoters = yield* Promoter.PromoterRegistry;
  yield* promoters.register(KnowledgePromoter.promoter);
  yield* promoters.register(PolicyPromoter.policyPromoter);
  yield* promoters.register(PolicyPromoter.promptPromoter);
  const supervisor = yield* PluginSupervisor.PluginSupervisor;
  // Classify before promote, so a tick hands over what it just classified.
  yield* supervisor.register(yield* ClassifySweep.sweep);
  yield* supervisor.register(yield* PromoteSweep.sweep);
  yield* supervisor.register(yield* RegressionSweep.sweep);
}).pipe(Effect.orDie);

/**
 * Records corrections, visible instances of work going wrong, from events the
 * server already emits: failed and interrupted provider turns, pull request
 * wakes while changes are requested, and threads reopened after settlement.
 * Two sweeps turn them into learning items, one per recurring failure mode per
 * project, and hand each item once to the owner kind the rules or a person
 * picked; a third opens an item for each efficiency measure that worsened from
 * one week to the next. MCP tools expose corrections and items to agents.
 */
export const plugin = {
  id: "learning",
  dependsOn: [],
  migrations,
  layer: Layer.effectDiscard(start).pipe(
    Layer.provideMerge(Layer.mergeAll(CorrectionStore.layer, ItemStore.layer, Promoter.layer)),
  ),
  mcp: (register) => register(Mcp.LearningToolkit, Mcp.handlers),
} satisfies ServerPlugin<unknown>;
