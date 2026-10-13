import type { LearningItemDetail } from "@t3tools/contracts";

/** How many of an item's latest pieces of evidence a draft quotes. */
const DRAFT_EVIDENCE_COUNT = 5;

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** A failure mode as a key fragment: `missing_verification` is `missing-verification`. */
export const modeSlug = (failureMode: string) =>
  failureMode
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * What a promoter hands a person to review, from the item alone: a title from the failure mode,
 * and a body of the item's reason followed by its latest evidence summaries, one bullet each.
 */
export const learnedDraft = ({ item, evidence }: LearningItemDetail) => ({
  title: `Learned: ${oneLine(item.failureMode.replaceAll("_", " "))}`,
  body: [
    oneLine(item.reason),
    evidence
      .slice(-DRAFT_EVIDENCE_COUNT)
      .map((entry) => `- ${oneLine(entry.summary)}`)
      .join("\n"),
  ]
    .filter((part) => part !== "")
    .join("\n\n"),
});
