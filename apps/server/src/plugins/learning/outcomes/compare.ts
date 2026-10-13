import type { LearningOwnerKind } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** How long a handover is watched on each side of its delivery. */
const WINDOW_DAYS = 28;

/** The fewest recurrences either window needs before it counts as a pattern. */
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
 * before its delivery and in the 28 days after. Under three before there is nothing to compare.
 * Three or more after means the mode is still a pattern, however many came before; none after
 * means it went quiet; one or two is better, and not yet quiet.
 */
export const judge = ({ before, after }: { readonly before: number; readonly after: number }) =>
  before < MIN_RECURRENCES
    ? "inconclusive"
    : after >= MIN_RECURRENCES
      ? "ineffective"
      : after === 0
        ? "settled"
        : "improved";

/**
 * The two windows around a delivery, as half-open ISO ranges: the before window ends where the
 * after window starts, so a correction made at the instant of delivery counts as after.
 */
export const windows = (deliveredAt: string) => {
  const at = DateTime.makeUnsafe(deliveredAt);
  return {
    before: {
      from: DateTime.formatIso(DateTime.subtract(at, { days: WINDOW_DAYS })),
      to: deliveredAt,
    },
    after: { from: deliveredAt, to: DateTime.formatIso(DateTime.add(at, { days: WINDOW_DAYS })) },
  };
};

/**
 * The latest delivery, as an ISO instant, whose after window is complete at `now`: a handover
 * delivered at or before it has had its whole four weeks.
 */
export const latestComplete = (now: DateTime.Utc) =>
  DateTime.formatIso(DateTime.subtract(now, { days: WINDOW_DAYS }));

/**
 * Whether a person set the item's disposition after the handover: they closed it or sent it
 * elsewhere, so there is nothing left to point out. Both are ISO instants; the item's is null
 * while the rules own it.
 */
export const respondedTo = (deliveredAt: string, dispositionAt: string | null) =>
  dispositionAt !== null && dispositionAt > deliveredAt;

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
