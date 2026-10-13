import { TELEMETRY_METHODS, TelemetryError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as PluginRpc from "../PluginRpc.ts";
import * as BudgetStore from "./budgets/BudgetStore.ts";
import * as Telemetry from "./Telemetry.ts";

const running = Option.match({
  onNone: () => new TelemetryError({ message: 'Plugin "telemetry" is not running.' }),
  onSome: Effect.succeed,
});

/** The RPC group needs every handler even when the plugin is off, so an inactive plugin answers with an error. */
const telemetry = Effect.serviceOption(Telemetry.Telemetry).pipe(Effect.flatMap(running));
const budgets = Effect.serviceOption(BudgetStore.BudgetStore).pipe(Effect.flatMap(running));

/** Merged into the host's dispatch table through `PluginHost.handlers`. */
export const table = PluginRpc.defineHandlers(TELEMETRY_METHODS)({
  measures: (input) => Effect.flatMap(telemetry, (t) => t.measures(input)),
  budgets: (input) => Effect.flatMap(budgets, (store) => store.list(input)),
  budgetsSet: (input) => Effect.flatMap(budgets, (store) => store.set(input)),
  budgetsRemove: ({ id }) =>
    Effect.flatMap(budgets, (store) => store.remove(id)).pipe(Effect.as({})),
  budgetEvents: (input) => Effect.flatMap(budgets, (store) => store.events(input)),
});
