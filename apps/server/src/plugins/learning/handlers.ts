import { LEARNING_METHODS, LearningError, PROMPT_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as PluginRpc from "../PluginRpc.ts";
import * as CorrectionStore from "./CorrectionStore.ts";
import * as ItemStore from "./items/ItemStore.ts";
import * as PromptStore from "./prompts/PromptStore.ts";

/** The handlers exist whether or not the plugin runs, so an inactive plugin answers with an error. */
const running = <A>(service: Option.Option<A>) =>
  Option.match(service, {
    onNone: () =>
      Effect.fail(
        new LearningError({ code: "inactive", message: 'Plugin "learning" is not running.' }),
      ),
    onSome: Effect.succeed,
  });
const corrections = Effect.flatMap(Effect.serviceOption(CorrectionStore.CorrectionStore), running);
const items = Effect.flatMap(Effect.serviceOption(ItemStore.ItemStore), running);
const prompts = Effect.flatMap(Effect.serviceOption(PromptStore.PromptStore), running);

/** Merged into the host's dispatch table through `PluginHost.handlers`. A save over RPC is a person's. */
export const table = {
  ...PluginRpc.defineHandlers(LEARNING_METHODS)({
    corrections: (input) => Effect.flatMap(corrections, (s) => s.list(input)),
    correction: ({ id }) => Effect.flatMap(corrections, (s) => s.get(id)),
    items: (input) => Effect.flatMap(items, (s) => s.list(input)),
    item: ({ id }) => Effect.flatMap(items, (s) => s.get(id)),
    itemsSetDisposition: (input) => Effect.flatMap(items, (s) => s.setDisposition(input)),
  }),
  ...PluginRpc.defineHandlers(PROMPT_METHODS)({
    list: (input) => Effect.flatMap(prompts, (s) => s.list(input)),
    get: ({ id }) => Effect.flatMap(prompts, (s) => s.get(id)),
    create: (input) => Effect.flatMap(prompts, (s) => s.create(input)),
    edit: (input) => Effect.flatMap(prompts, (s) => s.edit(input)),
    revert: (input) => Effect.flatMap(prompts, (s) => s.revert(input)),
    accept: ({ id }) => Effect.flatMap(prompts, (s) => s.accept(id)),
    archive: ({ id }) => Effect.flatMap(prompts, (s) => s.archive(id)),
    unarchive: ({ id }) => Effect.flatMap(prompts, (s) => s.unarchive(id)),
    use: ({ id }) => Effect.flatMap(prompts, (s) => s.use(id)),
  }),
};
