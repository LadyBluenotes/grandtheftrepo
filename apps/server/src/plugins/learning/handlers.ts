import { LEARNING_METHODS, LearningError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as PluginRpc from "../PluginRpc.ts";
import * as CorrectionStore from "./CorrectionStore.ts";

/** The handlers exist whether or not the plugin runs, so an inactive plugin answers with an error. */
const store = Effect.serviceOption(CorrectionStore.CorrectionStore).pipe(
  Effect.flatMap(
    Option.match({
      onNone: () =>
        new LearningError({ code: "inactive", message: 'Plugin "learning" is not running.' }),
      onSome: Effect.succeed,
    }),
  ),
);

/** Merged into the host's dispatch table through `PluginHost.handlers`. */
export const table = PluginRpc.defineHandlers(LEARNING_METHODS)({
  corrections: (input) => Effect.flatMap(store, (s) => s.list(input)),
  correction: ({ id }) => Effect.flatMap(store, (s) => s.get(id)),
});
