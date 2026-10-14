import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as SqlError from "effect/sql/SqlError";
import * as KnowledgePromoter from "../knowledge/promoter.ts";
import type { ServerPlugin } from "../Plugin.ts";
import * as PluginReactor from "../PluginReactor.ts";
import * as PluginSupervisor from "../PluginSupervisor.ts";
import * as PolicyPromoter from "../policy/promoter.ts";
import { fromService } from "../Readiness.ts";
import * as ClassifySweep from "./ClassifySweep.ts";
import * as CorrectionStore from "./CorrectionStore.ts";
import * as ItemStore from "./items/ItemStore.ts";
import * as Mcp from "./mcp.ts";
import { migrations } from "./migrations.ts";
import * as OutcomeSweep from "./outcomes/OutcomeSweep.ts";
import * as ChangesRequested from "./producers/changesRequested.ts";
import * as Reopened from "./producers/reopened.ts";
import * as TurnFailures from "./producers/turnFailures.ts";
import * as PromoteSweep from "./PromoteSweep.ts";
import * as Promoter from "./Promoter.ts";
import * as PromptPromoter from "./prompts/promoter.ts";
import * as PromptStore from "./prompts/PromptStore.ts";
import * as Checks from "./readiness.ts";
import * as RegressionSweep from "./regressions/RegressionSweep.ts";
import * as ReviewSweep from "./ReviewSweep.ts";

/** Every producer's handlers, run by one reactor from the first event the server ever committed. */
export const handlers = {
  ...TurnFailures.handlers,
  ...ChangesRequested.handlers,
  ...Reopened.handlers,
} satisfies PluginReactor.Handlers<SqlError.SqlError>;

// None fails in a state the plugin can run in: the reactor's cursor tables go in the database
// the host just migrated, and a second sweep or promoter under this plugin's own name is a defect.
const start = Effect.gen(function* () {
  const reactor = yield* PluginReactor.start({ plugin: "learning", from: "start", handlers });
  // The knowledge and policy plugins are reached when a sweep runs, so each promoter says whether
  // its plugin is there; learning depends on neither, and a plugin that is off costs nothing. The
  // prompt library is this plugin's own.
  const promoters = yield* Promoter.PromoterRegistry;
  yield* promoters.register(KnowledgePromoter.promoter);
  yield* promoters.register(PolicyPromoter.policyPromoter);
  yield* promoters.register(yield* PromptPromoter.promoter);
  const supervisor = yield* PluginSupervisor.PluginSupervisor;
  // Classify before promote, so a tick hands over what it just classified.
  yield* supervisor.register(yield* ClassifySweep.sweep);
  yield* supervisor.register(yield* PromoteSweep.sweep);
  // After promote, so a draft written this tick is flagged for review in the same one.
  yield* supervisor.register(yield* ReviewSweep.sweep);
  yield* supervisor.register(yield* RegressionSweep.sweep);
  // A verdict is permanent, so the outcome sweep waits for the reactor that records corrections.
  yield* supervisor.register(yield* OutcomeSweep.sweep(reactor.drain));
}).pipe(Effect.orDie);

/**
 * Records corrections, visible instances of work going wrong, from events the
 * server already emits: failed and interrupted provider turns, pull request
 * wakes while changes are requested, and threads reopened after settlement.
 * The kanban store and the review plugin's security sweep record theirs too:
 * tickets reopened from Done and security findings.
 * Two sweeps turn them into learning items, one per recurring failure mode per
 * project, and hand each item once to the owner kind the rules or a person
 * picked, as a draft someone other than its proposer reviews; a third flags
 * each handover waiting for that review, a fourth opens an item for each
 * efficiency measure that worsened from one week to the next, and a fifth flags
 * an adopted handover whose failure mode kept recurring, or went quiet, in the
 * four weeks after its adoption. MCP tools expose corrections and items to
 * agents, and take an agent's verdict on a handover. It also keeps each
 * project's prompt library, saved prompts and workflows that agents search and
 * propose to over MCP and people manage on the Learning screen.
 */
export const plugin = {
  id: "learning",
  dependsOn: [],
  migrations,
  layer: Layer.merge(Layer.effectDiscard(start), Checks.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(CorrectionStore.layer, ItemStore.layer, Promoter.layer, PromptStore.layer),
    ),
  ),
  mcp: (register) => register(Mcp.LearningToolkit, Mcp.handlers),
  readiness: fromService(Checks.LearningReadiness),
} satisfies ServerPlugin<unknown>;
