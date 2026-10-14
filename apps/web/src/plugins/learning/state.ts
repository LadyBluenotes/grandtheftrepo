import { useAtomValue } from "@effect/atom-react";
import {
  createPluginRpcCommand,
  createPluginRpcQueryAtomFamily,
} from "@t3tools/client-runtime/plugins/rpc";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  LEARNING_METHODS,
  REVIEW_METHODS,
  type EnvironmentId,
  type LearningCorrection,
  type LearningDeclaredMode,
  type LearningFailureKind,
  type LearningItem,
  type LearningItemState,
  type LearningItemsSetDispositionInput,
  type LearningOwnerKind,
  type LearningPromotion,
  type PluginStatus,
  type ProjectId,
  type ReviewOutcome,
  type ReviewRequest,
  type ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "~/connection/runtime";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

export interface LearningScope {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

/**
 * Nothing pushes learning or review changes to clients, and the sweeps that make them run on the
 * supervisor's minute tick, so every list re-reads when the window regains focus and after a
 * command from this screen. None of them polls.
 */
const onWindowFocus = () => Atom.windowFocusSignal;

const learningItems = createPluginRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:plugins:learning:items",
  method: LEARNING_METHODS.items,
  refreshTrigger: onWindowFocus,
});

const learningItem = createPluginRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:plugins:learning:item",
  method: LEARNING_METHODS.item,
  refreshTrigger: onWindowFocus,
});

const learningCorrections = createPluginRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:plugins:learning:corrections",
  method: LEARNING_METHODS.corrections,
  refreshTrigger: onWindowFocus,
});

const reviewVerdicts = createPluginRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:plugins:learning:verdicts",
  method: REVIEW_METHODS.verdicts,
  refreshTrigger: onWindowFocus,
});

const reviewRequests = createPluginRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:plugins:learning:requests",
  method: REVIEW_METHODS.requestsList,
  refreshTrigger: onWindowFocus,
});

const learningSetDisposition = createPluginRpcCommand(connectionAtomRuntime, {
  label: "learning:set-disposition",
  method: LEARNING_METHODS.itemsSetDisposition,
});

/** A project's items in every state; `itemRows` applies the state filter on the client. */
export function useLearningItems({ environmentId, projectId }: LearningScope) {
  return useEnvironmentQuery(learningItems({ environmentId, input: { projectId } }));
}

/** One item with its evidence and promotions; nothing while either argument is null. */
export function useLearningItem(environmentId: EnvironmentId | null, id: number | null) {
  return useEnvironmentQuery(
    environmentId === null || id === null ? null : learningItem({ environmentId, input: { id } }),
  );
}

/**
 * The Learning screen's project: the one a person picked, else the environment's first (null),
 * until an item the URL opens names its own. `followed` is the open item's project once loaded.
 */
export interface LearningProjectChoice {
  readonly projectId: string | null;
  readonly followed: string | undefined;
}

export const NO_PROJECT_CHOICE: LearningProjectChoice = { projectId: null, followed: undefined };

/**
 * The choice once the open item's project is known, or once it closes (`undefined`). Every item
 * the URL opens, from a link or the browser's history, selects its project when it loads; a
 * person's pick while it stays open is kept.
 */
export function followOpenItem(
  choice: LearningProjectChoice,
  itemProjectId: string | undefined,
): LearningProjectChoice {
  if (itemProjectId === choice.followed) return choice;
  return { projectId: itemProjectId ?? choice.projectId, followed: itemProjectId };
}

/** The item a `/plugins/learning` link names by `recordId`, or null for anything but an item id. */
export function learningItemId(recordId: string | undefined): number | null {
  if (recordId === undefined || !/^\d+$/.test(recordId)) return null;
  const id = Number(recordId);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** A project's corrections in `window`, every kind and mode; `filterCorrections` narrows them. */
export function useLearningCorrections(
  { environmentId, projectId }: LearningScope,
  window: CorrectionWindow,
) {
  return useEnvironmentQuery(
    learningCorrections({ environmentId, input: { projectId, ...window } }),
  );
}

export function useReviewVerdicts(environmentId: EnvironmentId, threadId: ThreadId | null) {
  return useEnvironmentQuery(
    threadId === null ? null : reviewVerdicts({ environmentId, input: { threadId } }),
  );
}

export function useReviewRequests(environmentId: EnvironmentId, threadId: ThreadId | null) {
  return useEnvironmentQuery(
    threadId === null ? null : reviewRequests({ environmentId, input: { threadId } }),
  );
}

/** Sets an item's owner kind or state on `environmentId`; `canWrite` follows its grant. */
export function useLearningSetDisposition(environmentId: EnvironmentId) {
  const run = useAtomCommand(learningSetDisposition, { reportFailure: false });
  const canWrite = useAtomValue(learningSetDisposition.permissionAtom(environmentId));
  return {
    canWrite,
    set: (input: LearningItemsSetDispositionInput) => run({ environmentId, input }),
  };
}

const oneOf =
  <T extends string>(values: ReadonlyArray<T>) =>
  (value: unknown): value is T =>
    typeof value === "string" && (values as ReadonlyArray<string>).includes(value);

export const ITEM_STATES = [
  "open",
  "candidate",
  "promoted",
  "closed",
] as const satisfies ReadonlyArray<LearningItemState>;
export const isItemState = oneOf(ITEM_STATES);
export const ITEM_STATE_LABEL: Record<LearningItemState, string> = {
  open: "Open",
  candidate: "Candidate",
  promoted: "Promoted",
  closed: "Closed",
};
export const ITEM_STATE_VARIANT: Record<
  LearningItemState,
  "info" | "warning" | "success" | "secondary"
> = {
  open: "info",
  candidate: "warning",
  promoted: "success",
  closed: "secondary",
};

export const OWNER_KINDS = [
  "project_knowledge",
  "prompt",
  "policy",
  "local_only",
] as const satisfies ReadonlyArray<LearningOwnerKind>;
export const isOwnerKind = oneOf(OWNER_KINDS);
export const OWNER_KIND_LABEL: Record<LearningOwnerKind, string> = {
  project_knowledge: "Project knowledge",
  prompt: "Prompt",
  policy: "Policy",
  local_only: "Local only",
};

export const FAILURE_KINDS = [
  "provider_turn_failed",
  "provider_turn_interrupted",
  "changes_requested",
  "reopened_after_settlement",
  "review_verdict",
  "security",
  "manual",
] as const satisfies ReadonlyArray<LearningFailureKind>;
export const isFailureKind = oneOf(FAILURE_KINDS);
export const FAILURE_KIND_LABEL: Record<LearningFailureKind, string> = {
  provider_turn_failed: "Turn failed",
  provider_turn_interrupted: "Turn interrupted",
  changes_requested: "Changes requested",
  reopened_after_settlement: "Reopened after done",
  review_verdict: "Review verdict",
  security: "Security finding",
  manual: "Manual",
};

export const DECLARED_MODES = [
  "defect",
  "incomplete",
  "scope_drift",
  "missing_verification",
  "convention",
  "unclear_spec",
  "security",
] as const satisfies ReadonlyArray<LearningDeclaredMode>;
export const isDeclaredMode = oneOf(DECLARED_MODES);
export const DECLARED_MODE_LABEL: Record<LearningDeclaredMode, string> = {
  defect: "Defect",
  incomplete: "Incomplete",
  scope_drift: "Scope drift",
  missing_verification: "Missing verification",
  convention: "Convention",
  unclear_spec: "Unclear spec",
  security: "Security",
};

export const PROMOTION_STATE_LABEL: Record<LearningPromotion["state"], string> = {
  pending: "Pending",
  delivered: "Delivered",
  failed: "Failed",
};
export const PROMOTION_STATE_VARIANT: Record<
  LearningPromotion["state"],
  "warning" | "success" | "error"
> = {
  pending: "warning",
  delivered: "success",
  failed: "error",
};

export const REVIEW_OUTCOME_LABEL: Record<ReviewOutcome, string> = {
  approve: "Approved",
  changes_requested: "Changes requested",
};
export const REVIEW_OUTCOME_VARIANT: Record<ReviewOutcome, "success" | "warning"> = {
  approve: "success",
  changes_requested: "warning",
};

export const REQUEST_STATUS_LABEL: Record<ReviewRequest["status"], string> = {
  open: "Open",
  answered: "Answered",
  stale: "Stale",
};
export const REQUEST_STATUS_VARIANT: Record<
  ReviewRequest["status"],
  "info" | "success" | "secondary"
> = {
  open: "info",
  answered: "success",
  stale: "secondary",
};

/** A declared mode by its name; any other mode, such as one a regression opens, with its underscores spaced. */
export function failureModeLabel(mode: string): string {
  if (isDeclaredMode(mode)) return DECLARED_MODE_LABEL[mode];
  const spaced = mode.replaceAll("_", " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** `rows` by `at`, an ISO instant, newest first; rows with the same instant keep their order. */
export function newestFirst<T>(rows: ReadonlyArray<T>, at: (row: T) => string): ReadonlyArray<T> {
  return rows.toSorted((left, right) => {
    const a = at(left);
    const b = at(right);
    return a === b ? 0 : a < b ? 1 : -1;
  });
}

export interface ItemRow {
  readonly id: number;
  readonly failureMode: string;
  readonly occurrences: number;
  readonly state: LearningItemState;
  readonly ownerKind: LearningOwnerKind | null;
  readonly setBy: LearningItem["dispositionBy"];
  /** When a person last set the disposition; null while the rules own it. */
  readonly setAt: string | null;
  readonly updatedAt: string;
}

/** The items table's rows: those in `state`, or all, the most recently updated first. */
export function itemRows(
  items: ReadonlyArray<LearningItem>,
  state: LearningItemState | null,
): ReadonlyArray<ItemRow> {
  return newestFirst(
    items.filter((item) => state === null || item.state === state),
    (item) => item.updatedAt,
  ).map((item) => ({
    id: item.id,
    failureMode: item.failureMode,
    occurrences: item.occurrences,
    state: item.state,
    ownerKind: item.ownerKind,
    setBy: item.dispositionBy,
    setAt: item.dispositionAt,
    updatedAt: item.updatedAt,
  }));
}

/** `none` keeps the corrections nobody declared a mode for. */
export type ModeFilter = LearningDeclaredMode | "none";

export interface CorrectionFilter {
  readonly kind: LearningFailureKind | null;
  readonly mode: ModeFilter | null;
}

/** The corrections `filter` keeps, newest first. */
export function filterCorrections(
  corrections: ReadonlyArray<LearningCorrection>,
  filter: CorrectionFilter,
): ReadonlyArray<LearningCorrection> {
  return newestFirst(
    corrections.filter(
      (correction) =>
        (filter.kind === null || correction.failureKind === filter.kind) &&
        (filter.mode === null ||
          (filter.mode === "none"
            ? correction.declaredMode === null
            : correction.declaredMode === filter.mode)),
    ),
    (correction) => correction.createdAt,
  );
}

export const CORRECTION_WINDOWS = [7, 30, 90] as const;
export type CorrectionWindowDays = (typeof CORRECTION_WINDOWS)[number];
export const isCorrectionWindow = (value: unknown): value is CorrectionWindowDays =>
  (CORRECTION_WINDOWS as ReadonlyArray<unknown>).includes(value);

export interface CorrectionWindow {
  readonly from: string;
  readonly to: string;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The last `days` days, up to the end of the current hour. Rounding `to` up keeps the query, and so
 * its cached answer, the same for the rest of the hour, while a correction made in that hour still
 * falls inside the window on the next refetch.
 */
export function correctionsWindow(
  days: CorrectionWindowDays,
  nowMs = Date.now(),
): CorrectionWindow {
  const to = (Math.floor(nowMs / HOUR_MS) + 1) * HOUR_MS;
  return { from: new Date(to - days * DAY_MS).toISOString(), to: new Date(to).toISOString() };
}

/** Whether `id` runs in the environment these statuses describe; false while they are unknown. */
export function pluginActive(statuses: ReadonlyArray<PluginStatus> | null, id: string): boolean {
  return statuses?.some((status) => status.id === id && status.active) ?? false;
}

export function threadLabel(thread: Pick<EnvironmentThreadShell, "title">): string {
  return thread.title.trim() || "Untitled thread";
}

/** The thread picker's order: the ones a user wrote to most recently first, then the rest by title. */
export function threadsByActivity(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<EnvironmentThreadShell> {
  return threads.toSorted((left, right) => {
    const a = left.latestUserMessageAt ?? "";
    const b = right.latestUserMessageAt ?? "";
    if (a !== b) return a < b ? 1 : -1;
    return threadLabel(left).localeCompare(threadLabel(right));
  });
}
