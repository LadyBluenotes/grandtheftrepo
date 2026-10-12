import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as SqlError from "effect/sql/SqlError";
import type { ServerPlugin } from "../Plugin.ts";
import * as PluginReactor from "../PluginReactor.ts";
import * as CorrectionStore from "./CorrectionStore.ts";
import * as Mcp from "./mcp.ts";
import { migrations } from "./migrations.ts";
import * as ChangesRequested from "./producers/changesRequested.ts";
import * as Reopened from "./producers/reopened.ts";
import * as TurnFailures from "./producers/turnFailures.ts";

/** Every producer's handlers, run by one reactor from the first event the server ever committed. */
export const handlers = {
  ...TurnFailures.handlers,
  ...ChangesRequested.handlers,
  ...Reopened.handlers,
} satisfies PluginReactor.Handlers<SqlError.SqlError>;

/**
 * Records corrections, visible instances of work going wrong, from events the
 * server already emits: failed and interrupted provider turns, pull request
 * wakes while changes are requested, and threads reopened after settlement.
 * Two read tools and one write tool expose them to agents.
 */
export const plugin = {
  id: "learning",
  dependsOn: [],
  migrations,
  layer: Layer.effectDiscard(
    PluginReactor.start({ plugin: "learning", from: "start", handlers }).pipe(
      // Its cursor tables go in the database the host just migrated: a failure here is a broken
      // SQLite build, not plugin state.
      Effect.orDie,
    ),
  ).pipe(Layer.provideMerge(CorrectionStore.layer)),
  mcp: (register) => register(Mcp.LearningToolkit, Mcp.handlers),
} satisfies ServerPlugin<unknown>;
