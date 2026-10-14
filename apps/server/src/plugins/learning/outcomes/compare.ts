import type { LearningOwnerKind } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** How long a handover is watched on each side of its adoption. */
const WINDOW_DAYS = 28;

/** The fewest recurrences the before window needs to be a pattern, and the after window to still be one. */
const MIN_RECURRENCES = 3;

export type Verdict = "ineffective" | "settled" | "improved" | "inconclusive";

/** The attention flag kind of each verdict that raises one. */
export const FLAG_KINDS = {
  ineffective: "promotion_ineffective",
  settled: "promotion_settled",
} as const;

/** The kind of flag a verdict raises, or null for a verdict that raises none. */
export const flagKind = (verdict: Verdict) =>
  verdict === "ineffective" || verdict === "settled" ? FLAG_KINDS[verdict] : null;

/**
 * What a handover did to its failure mode, from the corrections with that mode in the 28 days
 * before its adoption and in the 28 days after. The first rule that fits decides:
 *
 * 1. Under three before, there is nothing to compare: `inconclusive`, whatever came after.
 * 2. None after: `settled`.
 * 3. After at most half of before: `improved`, however many are left. Three after from twenty
 *    before is a fix that mostly took.
 * 4. Three or more after: `ineffective`. The mode is still a pattern and fell by less than half.
 * 5. Otherwise, two after from three before: too little change to call either way, so
 *    `inconclusive`.
 *
 * Issue #88's prose for `ineffective` was "after at least before and at least 3", which contradicts
 * its own fixture of 5 before and 4 after raising one. The fixtures stand, and rule 3 keeps a large
 * drop from reading as "did not take".
 */
export const judge = ({ before, after }: { readonly before: number; readonly after: number }) =>
  before < MIN_RECURRENCES
    ? "inconclusive"
    : after === 0
      ? "settled"
      : after * 2 <= before
        ? "improved"
        : after >= MIN_RECURRENCES
          ? "ineffective"
          : "inconclusive";

/**
 * The two windows around an adoption, as half-open ISO ranges: the before window ends where the
 * after window starts, so a correction made at the instant of adoption counts as after.
 */
export const windows = (adoptedAt: string) => {
  const at = DateTime.makeUnsafe(adoptedAt);
  return {
    before: {
      from: DateTime.formatIso(DateTime.subtract(at, { days: WINDOW_DAYS })),
      to: adoptedAt,
    },
    after: { from: adoptedAt, to: DateTime.formatIso(DateTime.add(at, { days: WINDOW_DAYS })) },
  };
};

/**
 * The latest adoption, as an ISO instant, whose after window is complete at `now`: a handover
 * adopted at or before it has had its whole four weeks.
 */
export const latestComplete = (now: DateTime.Utc) =>
  DateTime.formatIso(DateTime.subtract(now, { days: WINDOW_DAYS }));

/**
 * Whether a person set the item's disposition after the adoption: they closed it or sent it
 * elsewhere, so there is nothing left to point out. Both are ISO instants; the item's is null
 * while the rules own it.
 */
export const respondedTo = (adoptedAt: string, dispositionAt: string | null) =>
  dispositionAt !== null && dispositionAt > adoptedAt;

const spaced = (name: string) => name.replaceAll("_", " ");

/** The flag a verdict raises, or null when it raises none. */
export const flagFor = (
  verdict: Verdict,
  input: {
    readonly failureMode: string;
    readonly ownerKind: LearningOwnerKind;
    readonly after: number;
  },
) => {
  const mode = spaced(input.failureMode);
  const subject = mode.charAt(0).toUpperCase() + mode.slice(1);
  if (verdict === "ineffective") {
    return {
      kind: FLAG_KINDS.ineffective,
      text: `${subject} recurred ${input.after} times in the four weeks after its ${spaced(input.ownerKind)} handover.`,
    } as const;
  }
  if (verdict === "settled") {
    return {
      kind: FLAG_KINDS.settled,
      text: `${subject} has not recurred in four weeks; close the item if it is done.`,
    } as const;
  }
  return null;
};
