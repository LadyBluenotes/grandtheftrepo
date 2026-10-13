import * as Effect from "effect/Effect";

import type * as Attention from "./Attention.ts";

/**
 * The flag both delivery sweeps keep when a block or file they installed was edited or deleted
 * outside T3 Code. A flag is keyed by the target, never by a thread, and the strip shows it with
 * its text alone.
 */
const KIND = "delivery_drift";
const RESUME_ACTION = { label: "Reinstall", target: "settings" } as const;

const list = new Intl.ListFormat("en", { type: "conjunction" });

/** The names quoted and joined, `"a"`, `"a" and "b"`, `"a", "b", and "c"`. */
export const quoted = (names: ReadonlyArray<string>) =>
  list.format(names.map((name) => `"${name}"`));

/**
 * The flag's one sentence. `what` is the subject without its place, such as `The knowledge
 * index`; `plural` is for a subject that names several things.
 */
export const flagText = (input: {
  readonly what: string;
  readonly path: string;
  readonly change: "edited" | "removed" | "edited or removed";
  readonly plural?: boolean;
}) =>
  `${input.what} in ${input.path} ${input.plural === true ? "were" : "was"} ${input.change} outside T3 Code; reinstall to restore ${input.plural === true ? "them" : "it"}.`;

/**
 * Brings `pluginId`'s open `delivery_drift` flags in line with what a tick found. `judged` maps a
 * flag's key to the sentence for a target that drifted, or to undefined for one that is intact; a
 * flag is raised for the first, cleared for the second, and rewritten only when its sentence
 * changed, so a tick that finds what the last one found writes nothing. An open flag whose key was
 * not judged belongs to a target the plugin no longer records, and is cleared, unless `leave`
 * names it: a target the tick could not read keeps whatever flag it had. A dry run changes
 * nothing. `changes` counts the raises, rewrites and clears, and `standing` the flags that stand
 * after them.
 */
export const reconcile = Effect.fn("DeliveryDrift.reconcile")(function* (
  attention: Attention.Attention["Service"],
  input: {
    readonly pluginId: string;
    readonly dryRun: boolean;
    readonly judged: ReadonlyMap<string, string | undefined>;
    readonly leave: (key: string) => boolean;
  },
) {
  const open = new Map(
    (yield* attention.listOpen({ pluginId: input.pluginId, kind: KIND })).map((flag) => [
      flag.threadId,
      flag.text,
    ]),
  );
  const flag = (key: string) => ({ pluginId: input.pluginId, threadId: key, kind: KIND }) as const;
  let changes = 0;
  let standing = 0;
  for (const [key, text] of input.judged) {
    if (text !== undefined) standing += 1;
    if (text === open.get(key)) continue;
    changes += 1;
    if (input.dryRun) continue;
    yield* text === undefined
      ? attention.clear(flag(key))
      : attention.raise({ ...flag(key), text, resumeAction: RESUME_ACTION });
  }
  for (const key of open.keys()) {
    if (input.judged.has(key)) continue;
    if (input.leave(key)) {
      standing += 1;
      continue;
    }
    changes += 1;
    if (!input.dryRun) yield* attention.clear(flag(key));
  }
  return { changes, standing };
});
