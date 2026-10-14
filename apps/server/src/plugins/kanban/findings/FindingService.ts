import {
  KanbanError,
  type KanbanActor,
  type KanbanFinding,
  type KanbanFindingMoveInput,
  type KanbanFindingPlacement,
  type KanbanFindingReviewInput,
  type KanbanFindingScope,
  type KanbanFindingTruth,
  type KanbanIssue,
  type KanbanVerification,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { slugOf, uniqueSlug } from "../KanbanFiles.ts";
import * as KanbanStore from "../KanbanStore.ts";

/** How many minutes a search lets its thread capture, once. */
export const SEARCH_WINDOW_MINUTES = 30;
/** The most matches of each kind a search answers with. */
const SEARCH_LIMIT = 10;

export interface FindingSearch {
  readonly searchId: string;
  /** Matching findings with the issue holding each, best match first. */
  readonly findings: ReadonlyArray<{
    readonly issue: KanbanIssue;
    readonly finding: KanbanFinding;
  }>;
  readonly issues: ReadonlyArray<KanbanIssue>;
}

export interface FindingCapture {
  readonly projectId: ProjectId;
  /** The capturing thread, which proposes the finding and must have made `searchId`. */
  readonly threadId: ThreadId;
  readonly searchId: string;
  readonly title: string;
  readonly evidence: string;
  readonly truthStatus: KanbanFindingTruth;
  readonly scopeRelation: KanbanFindingScope;
  /** The issue it concerns; omitted, a Triage issue labeled `finding` is opened for it. */
  readonly issueId?: string | undefined;
}

/**
 * Problems an agent found outside its task. A finding lives in an issue file, on the issue it
 * concerns or on a Triage issue opened for it, so the board's files stay the only copy. Capture
 * needs a search the same thread made in the same project in the last `SEARCH_WINDOW_MINUTES`,
 * so duplicates are looked for first. Searches are kept in memory: after a restart an agent
 * searches again.
 */
export class FindingService extends Context.Service<
  FindingService,
  {
    /** Findings and issues matching `query`, and a search id `threadId` may capture with once. */
    readonly search: (input: {
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
      readonly query: string;
    }) => Effect.Effect<FindingSearch, KanbanError>;
    readonly capture: (input: FindingCapture) => Effect.Effect<KanbanFindingPlacement, KanbanError>;
    /** Sets the disposition as `by`, who may not be the proposer; `open` reopens it. */
    readonly review: (
      input: KanbanFindingReviewInput,
      by: KanbanActor,
    ) => Effect.Effect<KanbanFindingPlacement, KanbanError>;
    /** Moves a finding to another issue, or to a new Triage issue for it, keeping all its fields. */
    readonly move: (
      input: KanbanFindingMoveInput,
      by: KanbanActor,
    ) => Effect.Effect<KanbanFindingPlacement, KanbanError>;
  }
>()("t3/plugins/kanban/findings/FindingService") {}

const invalid = (message: string) => new KanbanError({ code: "invalid", message });
const notFound = (message: string) => new KanbanError({ code: "not_found", message });

/** A Triage card opened for a finding starts as verified as the finding is. */
const VERIFICATION: Record<KanbanFindingTruth, KanbanVerification> = {
  seen: "unverified",
  partially_verified: "partial",
  reproduced: "verified",
  refuted: "unverified",
  unknown: "unverified",
};

const words = (text: string) =>
  text
    .normalize("NFKD")
    .toLowerCase()
    .match(/[a-z0-9]+/g) ?? [];

/** How many of the query's words start a word of `text`. */
const score = (query: ReadonlySet<string>, text: string) => {
  const have = words(text);
  let matched = 0;
  for (const term of query) if (have.some((word) => word.startsWith(term))) matched += 1;
  return matched;
};

/** The best `SEARCH_LIMIT` items that match at all, ties newest first. */
const best =
  <A>(items: ReadonlyArray<A>, text: (item: A) => string, at: (item: A) => string) =>
  (query: ReadonlySet<string>) =>
    items
      .map((item) => ({ item, score: score(query, text(item)) }))
      .filter((match) => match.score > 0)
      .sort((a, b) => b.score - a.score || at(b.item).localeCompare(at(a.item)))
      .slice(0, SEARCH_LIMIT)
      .map((match) => match.item);

const locate = (issues: ReadonlyMap<string, KanbanIssue>, id: string) => {
  for (const issue of issues.values()) {
    const finding = issue.findings.find((f) => f.id === id);
    if (finding !== undefined) return Effect.succeed({ issue, finding });
  }
  return Effect.fail(notFound(`No finding "${id}".`));
};

/** `issue` holding `finding`, in place of one with its id or at the end, with `text` logged. */
const holding = (
  issue: KanbanIssue,
  finding: KanbanFinding,
  by: KanbanActor,
  at: string,
  text: string,
): KanbanIssue => ({
  ...issue,
  findings: issue.findings.some((f) => f.id === finding.id)
    ? issue.findings.map((f) => (f.id === finding.id ? finding : f))
    : [...issue.findings, finding],
  updatedAt: at,
  log: [...issue.log, { at, by, kind: "finding", text }],
});

/**
 * The issue `issueId` holding `finding`, or without an id a new Triage issue labeled `finding` for
 * it, with its evidence as the description; `text` is logged on it.
 */
const placed = (
  issues: ReadonlyMap<string, KanbanIssue>,
  issueId: string | undefined,
  finding: KanbanFinding,
  by: KanbanActor,
  at: string,
  text: string,
) => {
  if (issueId === undefined) {
    const card = KanbanStore.newIssue(
      {
        id: uniqueSlug(slugOf(finding.title), (slug) => issues.has(slug)),
        title: finding.title,
        status: "triage",
        priority: "p3",
        labels: ["finding"],
        verification: VERIFICATION[finding.truthStatus],
        tier: null,
        description: finding.evidence,
      },
      by,
      at,
    );
    return Effect.succeed(holding(card, finding, by, at, text));
  }
  const target = issues.get(issueId);
  return target === undefined
    ? Effect.fail(notFound(`No issue "${issueId}".`))
    : Effect.succeed(holding(target, finding, by, at, text));
};

const make = Effect.gen(function* () {
  const store = yield* KanbanStore.KanbanStore;
  const searches = new Map<
    string,
    { readonly projectId: ProjectId; readonly threadId: ThreadId; readonly at: number }
  >();
  let searchCount = 0;
  const windowMillis = SEARCH_WINDOW_MINUTES * 60_000;

  const search: FindingService["Service"]["search"] = ({ projectId, threadId, query }) =>
    Effect.gen(function* () {
      const terms = new Set(words(query));
      const all = yield* store.transact(projectId, (issues) =>
        Effect.succeed({ result: [...issues.values()], save: [] }),
      );
      const now = yield* Clock.currentTimeMillis;
      for (const [id, made] of searches) if (now - made.at > windowMillis) searches.delete(id);
      searchCount += 1;
      const searchId = `s${searchCount}`;
      searches.set(searchId, { projectId, threadId, at: now });
      return {
        searchId,
        findings: best(
          all.flatMap((issue) => issue.findings.map((finding) => ({ issue, finding }))),
          ({ finding }) => `${finding.title} ${finding.evidence}`,
          ({ finding }) => finding.proposedAt,
        )(terms),
        issues: best(
          all,
          (issue) => `${issue.title} ${issue.description} ${issue.labels.join(" ")}`,
          (issue) => issue.updatedAt,
        )(terms),
      };
    });

  const capture: FindingService["Service"]["capture"] = (input) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const made = searches.get(input.searchId);
      if (
        made === undefined ||
        made.threadId !== input.threadId ||
        made.projectId !== input.projectId ||
        now - made.at > windowMillis
      )
        return yield* invalid(
          `Search first: call finding_search from this thread and pass its searchId. Search "${input.searchId}" was not made by this thread in this project in the last ${SEARCH_WINDOW_MINUTES} minutes, or a capture used it already.`,
        );
      // Taken before the write, so no second capture uses it meanwhile; given back on failure.
      searches.delete(input.searchId);
      const by = `thread:${input.threadId}`;
      return yield* store
        .transact(input.projectId, (issues, at) =>
          Effect.gen(function* () {
            const taken = new Set([...issues.values()].flatMap((i) => i.findings.map((f) => f.id)));
            const finding: KanbanFinding = {
              id: uniqueSlug(slugOf(input.title), (slug) => taken.has(slug)),
              title: input.title,
              evidence: input.evidence,
              truthStatus: input.truthStatus,
              scopeRelation: input.scopeRelation,
              disposition: "open",
              proposedBy: by,
              proposedAt: at,
              threadId: input.threadId,
              review: null,
            };
            const issue = yield* placed(
              issues,
              input.issueId,
              finding,
              by,
              at,
              `${finding.id} added: ${finding.title}`,
            );
            return {
              result: { projectId: input.projectId, issueId: issue.id, finding },
              save: [issue],
            };
          }),
        )
        .pipe(Effect.onError(() => Effect.sync(() => searches.set(input.searchId, made))));
    });

  const review: FindingService["Service"]["review"] = (
    { projectId, id, disposition, reason },
    by,
  ) =>
    store.transact(projectId, (issues, at) =>
      Effect.gen(function* () {
        const { issue, finding } = yield* locate(issues, id);
        if (finding.proposedBy === by)
          return yield* new KanbanError({
            code: "gated",
            message: "A finding is reviewed by someone other than the one who captured it.",
          });
        const reviewed: KanbanFinding = { ...finding, disposition, review: { by, at, reason } };
        return {
          result: { projectId, issueId: issue.id, finding: reviewed },
          save: [holding(issue, reviewed, by, at, `${id} ${disposition}: ${reason}`)],
        };
      }),
    );

  const move: FindingService["Service"]["move"] = ({ projectId, id, issueId }, by) =>
    store.transact(projectId, (issues, at) =>
      Effect.gen(function* () {
        const { issue: from, finding } = yield* locate(issues, id);
        if (issueId === from.id) return yield* invalid(`Finding "${id}" is already on ${issueId}.`);
        const to = yield* placed(issues, issueId, finding, by, at, `${id} moved from ${from.id}`);
        const left: KanbanIssue = {
          ...from,
          findings: from.findings.filter((f) => f.id !== id),
          updatedAt: at,
          log: [...from.log, { at, by, kind: "finding", text: `${id} moved to ${to.id}` }],
        };
        // Added before it is removed: a failed second write leaves it on both issues, not neither.
        return { result: { projectId, issueId: to.id, finding }, save: [to, left] };
      }),
    );

  return FindingService.of({ search, capture, review, move });
});

export const layer = Layer.effect(FindingService, make);
