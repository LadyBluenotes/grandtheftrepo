import type { KanbanAlternative, KanbanDecision, KanbanDecisionState } from "@t3tools/contracts";

/** How one decision names another, as `supersedes` and `supersededBy` do: `<category>/<id>`. */
export const decisionRef = (decision: Pick<KanbanDecision, "category" | "id">) =>
  `${decision.category}/${decision.id}`;

/** The option the decision went with, when it recorded one. */
export const chosenAlternative = (decision: KanbanDecision): KanbanAlternative | undefined =>
  decision.alternatives.find((alternative) => alternative.disposition === "chosen");

/** When the decision last changed: its newest revision, or when it was recorded. */
const lastChanged = (decision: KanbanDecision) =>
  decision.revisions.reduce(
    (latest, revision) => (revision.at > latest ? revision.at : latest),
    decision.at,
  );

/** Most recently changed first; ties by reference, so the order holds still between reads. */
export function sortDecisions(
  decisions: ReadonlyArray<KanbanDecision>,
): ReadonlyArray<KanbanDecision> {
  return [...decisions].sort(
    (a, b) =>
      lastChanged(b).localeCompare(lastChanged(a)) || decisionRef(a).localeCompare(decisionRef(b)),
  );
}

export interface DecisionFilter {
  /** Words that must all appear in a decision's title, why, alternatives or reconsider-when. */
  readonly query: string;
  readonly state: KanbanDecisionState | null;
  readonly category: string | null;
  /** Superseded decisions stay hidden unless this is on or `state` asks for them. */
  readonly showSuperseded: boolean;
}

const words = (query: string) => [
  ...new Set(
    query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 0),
  ),
];

const matches = (decision: KanbanDecision, terms: ReadonlyArray<string>) => {
  if (terms.length === 0) return true;
  const text = [
    decisionRef(decision),
    decision.title,
    decision.why,
    decision.reconsiderWhen ?? "",
    ...decision.alternatives.flatMap((alternative) => [alternative.title, alternative.reason]),
  ]
    .join("\n")
    .toLowerCase();
  return terms.every((term) => text.includes(term));
};

/**
 * The decisions a filter keeps, most recently changed first. Every word of the query must appear
 * somewhere in the decision's text, in any case, so typing more narrows the list.
 */
export function filterDecisions(
  decisions: ReadonlyArray<KanbanDecision>,
  filter: DecisionFilter,
): ReadonlyArray<KanbanDecision> {
  const terms = words(filter.query);
  return sortDecisions(
    decisions.filter(
      (decision) =>
        (filter.category === null || decision.category === filter.category) &&
        (filter.state === null
          ? filter.showSuperseded || decision.state !== "superseded"
          : decision.state === filter.state) &&
        matches(decision, terms),
    ),
  );
}
