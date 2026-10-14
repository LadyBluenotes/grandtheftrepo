import * as Attention from "./Attention.ts";

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
 * Brings `pluginId`'s open `delivery_drift` flags in line with what a tick found, as
 * `Attention.reconcile` does: `judged` maps a flag's key to the sentence for a target that drifted,
 * or to undefined for one that is intact, and `leave` names a target the tick could not read.
 */
export const reconcile = (
  attention: Attention.Attention["Service"],
  input: {
    readonly pluginId: string;
    readonly dryRun: boolean;
    readonly judged: ReadonlyMap<string, string | undefined>;
    readonly leave: (key: string) => boolean;
  },
) => Attention.reconcile(attention, { ...input, kind: KIND, resumeAction: RESUME_ACTION });
