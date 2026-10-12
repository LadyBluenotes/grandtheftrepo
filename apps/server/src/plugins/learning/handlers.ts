import {
  LEARNING_WS_METHODS,
  type LearningCorrectionInput,
  type LearningCorrectionsInput,
  LearningError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as CorrectionStore from "./CorrectionStore.ts";

/** The RPC group needs every handler even when the plugin is off, so an inactive plugin answers with an error. */
const store = Effect.serviceOption(CorrectionStore.CorrectionStore).pipe(
  Effect.flatMap(
    Option.match({
      onNone: () =>
        new LearningError({ code: "inactive", message: 'Plugin "learning" is not running.' }),
      onSome: Effect.succeed,
    }),
  ),
);

/** Spread into the WebSocket handlers through `PluginHost.handlers`. */
export const handlers = {
  [LEARNING_WS_METHODS.corrections]: (input: LearningCorrectionsInput) =>
    Effect.flatMap(store, (s) => s.list(input)),
  [LEARNING_WS_METHODS.correction]: ({ id }: LearningCorrectionInput) =>
    Effect.flatMap(store, (s) => s.get(id)),
};
