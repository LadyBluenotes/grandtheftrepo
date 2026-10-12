import { REVIEW_METHODS, ReviewVerdictError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as PluginRpc from "../PluginRpc.ts";
import * as VerdictStore from "./VerdictStore.ts";

/** The handlers exist whether or not the plugin runs, so an inactive plugin answers with an error. */
const store = Effect.serviceOption(VerdictStore.VerdictStore).pipe(
  Effect.flatMap(
    Option.match({
      onNone: () =>
        new ReviewVerdictError({ code: "inactive", message: 'Plugin "review" is not running.' }),
      onSome: Effect.succeed,
    }),
  ),
);

/** Merged into the host's dispatch table through `PluginHost.handlers`. */
export const table = PluginRpc.defineHandlers(REVIEW_METHODS)({
  verdicts: (input) => Effect.flatMap(store, (s) => s.list(input)),
});
