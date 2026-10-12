import type {
  LearningCorrection,
  LearningDeclaredMode,
  LearningFailureKind,
  LearningOwnerKind,
} from "@t3tools/contracts";

/** Kinds a provider's runtime reports; a failed turn says nothing about how the work was judged. */
const PROVIDER_FAILURE_KINDS: ReadonlySet<LearningFailureKind> = new Set([
  "provider_turn_failed",
  "provider_turn_interrupted",
]);

/**
 * A correction's failure mode, or null when it stays `unclassified`, and why. Only the failure
 * kind and the declared mode decide it; the description is prose and never an input.
 */
export const classify = ({
  failureKind,
  declaredMode,
}: Pick<LearningCorrection, "failureKind" | "declaredMode">) =>
  PROVIDER_FAILURE_KINDS.has(failureKind)
    ? { failureMode: null, reason: "provider failure" }
    : declaredMode === null
      ? { failureMode: null, reason: "no declared mode" }
      : { failureMode: declaredMode, reason: "declared mode" };

/** Who acts on each declared mode. A failure mode with no entry, such as a regression, has no rule. */
const OWNER_BY_MODE = {
  convention: "project_knowledge",
  scope_drift: "policy",
  missing_verification: "policy",
  defect: "local_only",
  incomplete: "local_only",
  unclear_spec: "local_only",
} as const satisfies Record<LearningDeclaredMode, LearningOwnerKind>;
const RULES: ReadonlyMap<string, LearningOwnerKind> = new Map(Object.entries(OWNER_BY_MODE));

/** An item that is not closed waits for promotion while its owner kind has something to hand over. */
export const routedState = (ownerKind: LearningOwnerKind | null) =>
  ownerKind === null || ownerKind === "local_only" ? "open" : "candidate";

/** The owner kind, state and reason the rules give an item, by its failure mode alone. */
export const route = (failureMode: string) => {
  const ownerKind = RULES.get(failureMode) ?? null;
  return {
    ownerKind,
    state: routedState(ownerKind),
    reason:
      ownerKind === null
        ? "No rule for this failure mode."
        : `Rule: ${failureMode} goes to ${ownerKind}.`,
  };
};
