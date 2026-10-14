// @effect-diagnostics nodeBuiltinImport:off - a plain sha256 of text; Effect's Crypto has no digest.
import {
  KANBAN_STATUSES,
  KanbanError,
  KanbanSlug,
  ThreadId,
  type KanbanActor,
  type KanbanBoard,
  type KanbanCriterion,
  type KanbanDecision,
  type KanbanGetIssueInput,
  type KanbanIssue,
  type KanbanIssueSummary,
  type KanbanListDecisionsInput,
  type KanbanSetCaptureInput,
  type KanbanSetDirectoryInput,
  type KanbanStatus,
  type KanbanWrite,
  type KanbanWriteResult,
  type ProjectId,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as NodeCrypto from "node:crypto";

import * as ServerConfig from "../../config.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { recordTicketReopen } from "../learning/producers/ticketReopens.ts";
import * as Files from "./KanbanFiles.ts";

/**
 * What `admit` compares: the hash of the issue a spec was checked or drafted from, which is the
 * title and description the drafting prompt is built from. The creation time is in it because a
 * card deleted and recreated under its title has the same slug and, if filed with the same text,
 * the same title and description; `createdAt` is set once and never rewritten.
 */
export const hashSource = (issue: Pick<KanbanIssue, "createdAt" | "title" | "description">) =>
  NodeCrypto.createHash("sha256")
    // Length-prefixed, so no text can move across a field boundary and hash the same.
    .update(
      [issue.createdAt, issue.title, issue.description]
        .map((field) => `${field.length}:${field}`)
        .join(""),
    )
    .digest("hex");

/** A new issue `by` files at `at`: no criteria, findings or threads, and its column as its log. */
export const newIssue = (
  fields: Pick<
    KanbanIssue,
    "id" | "title" | "status" | "priority" | "labels" | "verification" | "tier" | "description"
  >,
  by: KanbanActor,
  at: string,
): KanbanIssue => ({
  ...fields,
  criteria: [],
  findings: [],
  blocked: null,
  reopened: null,
  threads: [],
  createdAt: at,
  createdBy: by,
  updatedAt: at,
  doneAt: fields.status === "done" ? at : null,
  archivedAt: null,
  log: [{ at, by, kind: "status", text: fields.status }],
});

/** Done issues wait this long before the sweep archives them. */
const ARCHIVE_AFTER = Duration.days(7);

/** Statuses only the user may move a card out of into real work. */
const HOLDING = new Set<KanbanStatus>(["triage", "inbox"]);
const rank = (status: KanbanStatus) => KANBAN_STATUSES.indexOf(status);

/**
 * `kanban.json` under the state directory: per-project base folder overrides, and the projects
 * whose settled threads are read for unrecorded decisions and findings.
 */
const Overrides = fromJsonStringPretty(
  Schema.Struct({
    directories: Schema.Record(Schema.String, Schema.String),
    capture: Schema.optional(Schema.Array(Schema.String)),
  }),
);
const decodeOverrides = Schema.decodeUnknownEffect(Overrides);
const encodeOverrides = Schema.encodeEffect(Overrides);

interface Loaded {
  readonly directory: string;
  /** The project slug every file in this folder should name. */
  readonly slug: string;
  readonly issues: Map<string, KanbanIssue>;
  readonly decisions: Map<string, Array<KanbanDecision>>;
  /** As `kanban.json` had it at load, then as `setCapture` saved it. */
  capture: boolean;
  readonly lock: Semaphore.Semaphore;
  /** Owns the folder watchers; closed when the folder changes. */
  readonly scope: Scope.Closeable;
}

export class KanbanStore extends Context.Service<
  KanbanStore,
  {
    /** The board now, then again after every change on disk or through this service. */
    readonly subscribeBoard: (projectId: ProjectId) => Stream.Stream<KanbanBoard, KanbanError>;
    readonly getIssue: (input: KanbanGetIssueInput) => Effect.Effect<KanbanIssue, KanbanError>;
    readonly listDecisions: (
      input: KanbanListDecisionsInput,
    ) => Effect.Effect<ReadonlyArray<KanbanDecision>, KanbanError>;
    /** `actor` is `user` for clients and `thread:<id>` for agents; the gate reads it. */
    readonly write: (
      projectId: ProjectId,
      actor: KanbanActor,
      write: KanbanWrite,
    ) => Effect.Effect<KanbanWriteResult, KanbanError>;
    readonly setDirectory: (input: KanbanSetDirectoryInput) => Effect.Effect<void, KanbanError>;
    readonly setCapture: (input: KanbanSetCaptureInput) => Effect.Effect<void, KanbanError>;
    /** Whether settle-time capture is on for the project, read from `kanban.json`; nothing is loaded. */
    readonly captures: (projectId: ProjectId) => Effect.Effect<boolean, KanbanError>;
    /**
     * Admits an issue from Triage or Inbox to Todo as `by`, in one write, with `criteria` as its
     * acceptance criteria in that order: one already there with the same text keeps its id and
     * state, and every other change is logged. The description is never touched.
     *
     * `sourceHash` is the `hashSource` of the issue the criteria came from: its creation time,
     * title and description. The check is inside the write, so an issue edited, or deleted and
     * recreated under the same id, since then is `changed`, in whatever column it is now. One
     * unchanged but already out of Triage and Inbox is `left` as it is. Either way nothing is
     * written.
     */
    readonly admit: (
      projectId: ProjectId,
      id: string,
      by: KanbanActor,
      criteria: ReadonlyArray<string>,
      sourceHash: string,
    ) => Effect.Effect<"admitted" | "left" | "changed", KanbanError>;
    /** Moves every issue linking `threadId` forward to `status`. Never leaves Triage or Inbox. */
    readonly advance: (
      projectId: ProjectId,
      threadId: ThreadId,
      status: KanbanStatus,
    ) => Effect.Effect<void, KanbanError>;
    /** Archives Done issues older than `ARCHIVE_AFTER` in every loaded project. */
    readonly sweepArchive: Effect.Effect<void>;
    readonly board: (projectId: ProjectId) => Effect.Effect<KanbanBoard, KanbanError>;
    /** The project's base folder as the board resolves it; unlike `board`, nothing is loaded or created. */
    readonly directory: (projectId: ProjectId) => Effect.Effect<string, KanbanError>;
    /** The loaded project holding an issue that links `threadId`, if any. No disk or database read. */
    readonly linkedProject: (threadId: ThreadId) => Effect.Effect<ProjectId | undefined>;
    /** Every loaded project's decisions. No disk read: a project loads on its board's first use. */
    readonly loadedDecisions: Effect.Effect<ReadonlyMap<ProjectId, ReadonlyArray<KanbanDecision>>>;
    /**
     * Runs `change` under the write lock on the project's issues as they are now, saves the issues
     * it returns and, when there are any, publishes the board. For changes that are no `write`
     * action, such as a finding, which can touch two issues at once.
     */
    readonly transact: <A>(
      projectId: ProjectId,
      change: (
        issues: ReadonlyMap<string, KanbanIssue>,
        at: string,
      ) => Effect.Effect<
        { readonly result: A; readonly save: ReadonlyArray<KanbanIssue> },
        KanbanError
      >,
    ) => Effect.Effect<A, KanbanError>;
  }
>()("t3/plugins/kanban/KanbanStore") {}

const invalid = (message: string) => new KanbanError({ code: "invalid", message });
/** The number the next server-made criterion id (`c<n>`) takes. */
const nextCriterionNumber = (criteria: ReadonlyArray<KanbanCriterion>) =>
  1 + criteria.reduce((max, c) => Math.max(max, Number(c.id.slice(1)) || 0), 0);
const notFound = (message: string) => new KanbanError({ code: "not_found", message });
const SUPERSEDE_ONLY =
  "A decision becomes superseded only through decision.supersede, which names its replacement.";
/** The fields `decision.update` edits, in the order a revision names them. */
const EDITABLE = ["title", "why", "alternatives", "reconsiderWhen", "issues", "threads"] as const;
const isThreadId = Schema.is(ThreadId);
/** The thread an agent actor (`thread:<id>`) writes from, if it is one. */
const actorThreads = (actor: KanbanActor): ReadonlyArray<ThreadId> => {
  const id = actor.startsWith("thread:") ? actor.slice("thread:".length) : "";
  return isThreadId(id) ? [id] : [];
};
const nullIfBlank = (text: string | undefined) =>
  text === undefined || text.trim().length === 0 ? null : text;

/**
 * The decisions matching any word of `query`, those matching most first, then the newest. A query
 * without words keeps every decision, in order.
 */
const search = (decisions: ReadonlyArray<KanbanDecision>, query: string) => {
  const terms = [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((term) => term.length > 0),
    ),
  ];
  if (terms.length === 0) return decisions;
  return decisions
    .map((decision) => {
      const text = [
        Files.decisionRef(decision),
        decision.title,
        decision.why,
        decision.reconsiderWhen ?? "",
        ...decision.alternatives.flatMap((alternative) => [alternative.title, alternative.reason]),
      ]
        .join("\n")
        .toLowerCase();
      return { decision, score: terms.filter((term) => text.includes(term)).length };
    })
    .filter((match) => match.score > 0)
    .toSorted((a, b) => b.score - a.score || b.decision.at.localeCompare(a.decision.at))
    .map((match) => match.decision);
};

/**
 * Sets every decision's `supersedes` to the decisions whose `supersededBy` names it. The superseded
 * side is the record of a link: a write saves its file first and the replacement's after, so one
 * that failed between the two, or a file edited by hand, reads as the superseded side says. A
 * `supersededBy` naming no decision is kept: the state and the revisions still say what replaced it.
 */
const relink = (decisions: Map<string, Array<KanbanDecision>>) => {
  const claims = new Map<string, Array<string>>();
  for (const list of decisions.values())
    for (const d of list)
      if (d.supersededBy !== null)
        claims.set(d.supersededBy, [...(claims.get(d.supersededBy) ?? []), Files.decisionRef(d)]);
  for (const [category, list] of decisions) {
    let changed = false;
    const next = list.map((d) => {
      const claimed = claims.get(Files.decisionRef(d)) ?? [];
      const kept = d.supersedes.filter((ref) => claimed.includes(ref));
      const added = claimed.filter((ref) => !kept.includes(ref));
      if (added.length === 0 && kept.length === d.supersedes.length) return d;
      changed = true;
      return { ...d, supersedes: [...kept, ...added] };
    });
    if (changed) decisions.set(category, next);
  }
};

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const projects = yield* ProjectService.ProjectService;
  const overridesPath = path.join(config.stateDir, "kanban.json");
  const loaded = new Map<ProjectId, Loaded>();
  // Outlives a reload so subscribers keep hearing about the project after its folder moves.
  const changes = new Map<ProjectId, PubSub.PubSub<void>>();
  const loadLock = yield* Semaphore.make(1);
  // One `kanban.json` read-modify-write at a time, so a folder change and a capture toggle that
  // cross keep each other.
  const overridesLock = yield* Semaphore.make(1);
  const isSlug = Schema.is(KanbanSlug);

  const io = (message: string) => (cause: unknown) =>
    Effect.logWarning(message, { cause }).pipe(
      Effect.andThen(Effect.fail(new KanbanError({ code: "io", message }))),
    );
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const changesOf = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const existing = changes.get(projectId);
      if (existing !== undefined) return existing;
      const created = yield* PubSub.sliding<void>(1);
      changes.set(projectId, created);
      return created;
    });
  const publish = (projectId: ProjectId) =>
    Effect.flatMap(changesOf(projectId), (pubsub) => PubSub.publish(pubsub, undefined)).pipe(
      Effect.asVoid,
    );

  const readOverrides = fs.exists(overridesPath).pipe(
    Effect.flatMap((exists) =>
      exists
        ? Effect.flatMap(fs.readFileString(overridesPath), decodeOverrides)
        : Effect.succeed<typeof Overrides.Type>({ directories: {} }),
    ),
    Effect.catch(io(`Could not read ${overridesPath}.`)),
  );

  const issuePath = (state: Loaded, id: string) =>
    path.join(state.directory, "issues", `${id}${Files.ISSUE_EXTENSION}`);
  const decisionPath = (state: Loaded, category: string) =>
    path.join(state.directory, "decisions", `${category}${Files.DECISION_EXTENSION}`);

  /** Re-reads one file into the index; a missing file drops its entry. */
  const refresh = Effect.fn("KanbanStore.refresh")(function* (state: Loaded, file: string) {
    const kind = path.dirname(file) === path.join(state.directory, "issues") ? "issue" : "decision";
    const extension = kind === "issue" ? Files.ISSUE_EXTENSION : Files.DECISION_EXTENSION;
    if (path.extname(file) !== extension) return;
    const id = path.basename(file, extension);
    if (!isSlug(id)) return;
    // Under the lock every write takes. An event is handled after the write behind it, so a refresh
    // that had read an issue file could resume after the store deleted it and index it again, and a
    // card filed under the same title got a "-2" slug.
    yield* state.lock.withPermits(1)(
      Effect.gen(function* () {
        if (!(yield* fs.exists(file))) {
          if (kind === "issue") state.issues.delete(id);
          else {
            state.decisions.delete(id);
            relink(state.decisions);
          }
          return;
        }
        const text = yield* fs.readFileString(file);
        if (kind === "issue") {
          const parsed = Files.parseIssue(id, text);
          if (parsed === null)
            return yield* Effect.logWarning("kanban: unreadable issue file", { file });
          if (parsed.project !== null && parsed.project !== state.slug)
            yield* Effect.logWarning("kanban: issue names another project", {
              file,
              project: parsed.project,
            });
          state.issues.set(id, parsed.issue);
        } else {
          const parsed = Files.parseDecisions(id, text);
          if (parsed === null)
            return yield* Effect.logWarning("kanban: unreadable decision file", { file });
          state.decisions.set(id, [...parsed]);
          relink(state.decisions);
        }
      }),
    );
  });

  const watch = (projectId: ProjectId, state: Loaded, dir: string) =>
    Stream.runForEach(fs.watch(dir), (event) => {
      const file = path.resolve(dir, event.path);
      if (path.dirname(file) !== dir) return Effect.void;
      return refresh(state, file).pipe(
        Effect.andThen(publish(projectId)),
        Effect.catch((cause) => Effect.logWarning("kanban: refresh failed", { file, cause })),
      );
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("kanban: watcher stopped", { dir, cause })),
      Effect.forkIn(state.scope),
    );

  /**
   * The folder override from `kanban.json`, else `<T3 home>/wiki/<project-slug>`, and whether the
   * file turns capture on.
   */
  const resolveDirectory = Effect.fn("KanbanStore.resolveDirectory")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projects.getById(projectId).pipe(
      Effect.catch(io("Could not read the project.")),
      Effect.flatMap(
        Option.match({
          onNone: () => notFound("The project was not found."),
          onSome: Effect.succeed,
        }),
      ),
    );
    const slug = Files.slugOf(project.title);
    const overrides = yield* readOverrides;
    return {
      slug,
      directory: overrides.directories[projectId] ?? path.join(config.baseDir, "wiki", slug),
      capture: overrides.capture?.includes(projectId) ?? false,
    };
  });

  const load = Effect.fn("KanbanStore.load")(function* (projectId: ProjectId) {
    const existing = loaded.get(projectId);
    if (existing !== undefined) return existing;
    return yield* loadLock.withPermits(1)(
      Effect.gen(function* () {
        const again = loaded.get(projectId);
        if (again !== undefined) return again;
        const { slug, directory, capture } = yield* resolveDirectory(projectId);
        const dirs = [path.join(directory, "issues"), path.join(directory, "decisions")];
        const state: Loaded = {
          directory,
          slug,
          issues: new Map(),
          decisions: new Map(),
          capture,
          lock: yield* Semaphore.make(1),
          scope: yield* Scope.make(),
        };
        for (const dir of dirs) {
          yield* fs
            .makeDirectory(dir, { recursive: true })
            .pipe(Effect.catch(io(`Could not create ${dir}.`)));
          const names = yield* fs
            .readDirectory(dir)
            .pipe(Effect.catch(io(`Could not read ${dir}.`)));
          for (const name of names)
            yield* refresh(state, path.join(dir, name)).pipe(
              Effect.catch(io(`Could not read ${path.join(dir, name)}.`)),
            );
          yield* watch(projectId, state, dir);
        }
        loaded.set(projectId, state);
        yield* sweepProject(projectId, state);
        return state;
      }),
    );
  });

  const summary = ({
    description: _description,
    log: _log,
    findings: _findings,
    criteria,
    ...rest
  }: KanbanIssue): KanbanIssueSummary => ({
    ...rest,
    criteriaOpen: criteria.filter((c) => !c.checked).length,
    criteriaTotal: criteria.length,
  });
  const board = (state: Loaded): KanbanBoard => ({
    directory: state.directory,
    capture: state.capture,
    issues: Array.from(state.issues.values(), summary),
    decisionCategories: Array.from(state.decisions, ([category, list]) => ({
      category,
      count: list.length,
    })),
  });

  const saveIssue = (state: Loaded, issue: KanbanIssue) =>
    writeFileStringAtomically({
      filePath: issuePath(state, issue.id),
      contents: Files.serializeIssue(issue, state.slug),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.catch(io(`Could not write ${issuePath(state, issue.id)}.`)),
      Effect.tap(() => Effect.sync(() => state.issues.set(issue.id, issue))),
    );

  /** Writes a category's file as `list`, then indexes it; a failed write leaves the index as it was. */
  const saveDecisions = (state: Loaded, category: string, list: ReadonlyArray<KanbanDecision>) => {
    const file = decisionPath(state, category);
    const written =
      list.length === 0
        ? fs.remove(file).pipe(Effect.catch(io(`Could not remove ${file}.`)))
        : writeFileStringAtomically({
            filePath: file,
            contents: Files.serializeDecisions(category, state.slug, list),
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.catch(io(`Could not write ${file}.`)),
          );
    return written.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          if (list.length === 0) state.decisions.delete(category);
          else state.decisions.set(category, [...list]);
          relink(state.decisions);
        }),
      ),
    );
  };

  const moved = (
    issue: KanbanIssue,
    status: KanbanStatus,
    by: KanbanActor,
    at: string,
  ): KanbanIssue =>
    issue.status === status
      ? issue
      : {
          ...issue,
          status,
          doneAt: status === "done" ? at : null,
          updatedAt: at,
          log: [...issue.log, { at, by, kind: "status", text: status }],
        };

  /** Agents may file and triage; only the user moves a card from the holding columns into work. */
  const gated = (actor: KanbanActor, from: KanbanStatus | null, to: KanbanStatus) =>
    actor !== "user" && (from === null || HOLDING.has(from)) && !HOLDING.has(to);

  /** Applies one write; `reopened` is the issue when the write brought it back out of Done. */
  const applyWrite = Effect.fn("KanbanStore.applyWrite")(function* (
    state: Loaded,
    actor: KanbanActor,
    w: KanbanWrite,
  ): Effect.fn.Return<KanbanWriteResult & { readonly reopened?: KanbanIssue }, KanbanError> {
    const at = yield* nowIso;
    const need = <T>(value: T | undefined, name: string): Effect.Effect<T, KanbanError> =>
      value === undefined
        ? Effect.fail(invalid(`${name} is required for ${w.action}.`))
        : Effect.succeed(value);
    const issue = (): Effect.Effect<KanbanIssue, KanbanError> =>
      need(w.id, "id").pipe(
        Effect.flatMap((id) => {
          const found = state.issues.get(id);
          return found === undefined
            ? Effect.fail(notFound(`No issue "${id}".`))
            : Effect.succeed(found);
        }),
      );
    const decision = (): Effect.Effect<
      { category: string; list: Array<KanbanDecision>; index: number },
      KanbanError
    > =>
      Effect.all([need(w.category, "category"), need(w.id, "id")]).pipe(
        Effect.flatMap(([category, id]) => {
          const list = state.decisions.get(category) ?? [];
          const index = list.findIndex((d) => d.id === id);
          return index === -1
            ? Effect.fail(notFound(`No decision "${id}" in ${category}.`))
            : Effect.succeed({ category, list, index });
        }),
      );
    /** A decision by `<category>/<id>`, or null. */
    const findRef = (ref: string) => {
      const [category = "", id = ""] = ref.split("/");
      const list = state.decisions.get(category) ?? [];
      const index = list.findIndex((d) => d.id === id);
      return index === -1 ? null : { category, list, index };
    };
    const revised = (next: KanbanDecision, change: string): KanbanDecision => ({
      ...next,
      revisions: [...next.revisions, { at, by: actor, change }],
    });
    /**
     * Saves a change to a supersession link: `own`, the superseded side and the record of the link,
     * first, then the replacement `ref` names, built by `change` from the index after the first
     * save. Only once the link has landed is the replacement's revision written, so a failure
     * between the two leaves the link as `own` says and the replacement's revision missing, never
     * a revision for a link that did not take. One file holding both is written once.
     */
    const saveLinked = (
      own: {
        readonly category: string;
        readonly index: number;
        readonly next: KanbanDecision;
      } | null,
      other: {
        readonly ref: string;
        readonly change: (found: KanbanDecision) => KanbanDecision;
      } | null,
    ) =>
      Effect.gen(function* () {
        const shared = own === null || other === null ? null : findRef(other.ref);
        if (own !== null && other !== null && shared?.category === own.category)
          return yield* saveDecisions(
            state,
            own.category,
            shared.list
              .with(own.index, own.next)
              .with(shared.index, other.change(shared.list[shared.index]!)),
          );
        if (own !== null)
          yield* saveDecisions(
            state,
            own.category,
            (state.decisions.get(own.category) ?? []).with(own.index, own.next),
          );
        const found = other === null ? null : findRef(other.ref);
        if (other !== null && found !== null)
          yield* saveDecisions(
            state,
            found.category,
            found.list.with(found.index, other.change(found.list[found.index]!)),
          );
      });
    const touch = (current: KanbanIssue, patch: Partial<KanbanIssue>): KanbanIssue => ({
      ...current,
      ...patch,
      updatedAt: at,
    });
    const logged = (current: KanbanIssue, kind: KanbanIssue["log"][number]["kind"], text: string) =>
      touch(current, { log: [...current.log, { at, by: actor, kind, text }] });

    switch (w.action) {
      case "issue.create": {
        const title = yield* need(w.title, "title");
        const status = w.status ?? (actor === "user" ? "todo" : "triage");
        if (gated(actor, null, status))
          return yield* new KanbanError({
            code: "gated",
            message: "Agents file issues into Triage or Inbox; the user decides what starts.",
          });
        const id = Files.uniqueSlug(Files.slugOf(title), (slug) => state.issues.has(slug));
        const created = newIssue(
          {
            id,
            title,
            status,
            priority: w.priority ?? "p3",
            labels: w.labels ?? [],
            verification: w.verification ?? "unverified",
            tier: w.tier ?? null,
            description: w.description ?? "",
          },
          actor,
          at,
        );
        yield* saveIssue(state, created);
        return { id };
      }
      case "issue.update": {
        const current = yield* issue();
        yield* saveIssue(
          state,
          touch(current, {
            ...(w.title === undefined ? {} : { title: w.title }),
            ...(w.description === undefined ? {} : { description: w.description }),
            ...(w.priority === undefined ? {} : { priority: w.priority }),
            ...(w.labels === undefined ? {} : { labels: w.labels }),
            ...(w.verification === undefined ? {} : { verification: w.verification }),
            ...(w.tier === undefined ? {} : { tier: w.tier }),
          }),
        );
        return { id: current.id };
      }
      case "issue.move": {
        const current = yield* issue();
        const status = yield* need(w.status, "status");
        if (gated(actor, current.status, status))
          return yield* new KanbanError({
            code: "gated",
            message: `Only the user moves a card out of ${current.status}.`,
          });
        const open = current.criteria.filter((c) => !c.checked).length;
        if (status === "done" && current.status !== "done" && open > 0)
          return yield* invalid(`${open} acceptance criteria are still open.`);
        let next = moved(current, status, actor, at);
        const reopening = current.status === "done" && status !== "done";
        if (reopening) {
          if (w.reopenReason === undefined)
            return yield* invalid(
              "A completed issue needs a reopen reason: defect or scope_change.",
            );
          next = {
            ...next,
            reopened: { reason: w.reopenReason, at, by: actor },
            log: [...next.log, { at, by: actor, kind: "reopened", text: w.reopenReason }],
          };
        }
        yield* saveIssue(state, next);
        return reopening ? { id: current.id, reopened: next } : { id: current.id };
      }
      case "criterion.add": {
        const current = yield* issue();
        const text = yield* need(w.text, "text");
        const next = nextCriterionNumber(current.criteria);
        yield* saveIssue(
          state,
          touch(logged(current, "criterion", `added: ${text}`), {
            criteria: [...current.criteria, { id: `c${next}`, text, checked: false }],
          }),
        );
        return { id: current.id };
      }
      case "criterion.update": {
        const current = yield* issue();
        const criterionId = yield* need(w.criterionId, "criterionId");
        const index = current.criteria.findIndex((c) => c.id === criterionId);
        if (index === -1) return yield* notFound(`No criterion "${criterionId}" on ${current.id}.`);
        const before = current.criteria[index]!;
        const after = {
          ...before,
          ...(w.text === undefined ? {} : { text: w.text }),
          ...(w.checked === undefined ? {} : { checked: w.checked }),
        };
        const change =
          after.checked !== before.checked
            ? `${after.checked ? "checked" : "unchecked"}: ${after.text}`
            : `edited: ${before.text} → ${after.text}`;
        const criteria = [...current.criteria];
        criteria[index] = after;
        yield* saveIssue(state, touch(logged(current, "criterion", change), { criteria }));
        return { id: current.id };
      }
      case "criterion.remove": {
        const current = yield* issue();
        const criterionId = yield* need(w.criterionId, "criterionId");
        const removed = current.criteria.find((c) => c.id === criterionId);
        if (removed === undefined)
          return yield* notFound(`No criterion "${criterionId}" on ${current.id}.`);
        yield* saveIssue(
          state,
          touch(logged(current, "criterion", `removed: ${removed.text}`), {
            criteria: current.criteria.filter((c) => c.id !== criterionId),
          }),
        );
        return { id: current.id };
      }
      case "issue.note": {
        const current = yield* issue();
        yield* saveIssue(state, logged(current, "note", yield* need(w.text, "text")));
        return { id: current.id };
      }
      case "issue.block": {
        const current = yield* issue();
        const reason = yield* need(w.reason, "reason");
        yield* saveIssue(
          state,
          touch(logged(current, "blocked", reason), { blocked: { reason, at, by: actor } }),
        );
        return { id: current.id };
      }
      case "issue.unblock": {
        const current = yield* issue();
        yield* saveIssue(state, touch(logged(current, "unblocked", ""), { blocked: null }));
        return { id: current.id };
      }
      case "issue.link": {
        const current = yield* issue();
        const threadId = yield* need(w.threadId, "threadId");
        if (gated(actor, current.status, "in_progress"))
          return yield* new KanbanError({
            code: "gated",
            message: `This issue is in ${current.status}; the user has not released it for work.`,
          });
        if (!current.threads.some((link) => link.id === threadId))
          yield* saveIssue(
            state,
            touch(current, { threads: [...current.threads, { id: threadId, linkedAt: at }] }),
          );
        return { id: current.id };
      }
      case "issue.unlink": {
        const current = yield* issue();
        const threadId = yield* need(w.threadId, "threadId");
        yield* saveIssue(
          state,
          touch(current, { threads: current.threads.filter((link) => link.id !== threadId) }),
        );
        return { id: current.id };
      }
      case "issue.archive":
      case "issue.unarchive": {
        const current = yield* issue();
        yield* saveIssue(
          state,
          touch(current, { archivedAt: w.action === "issue.archive" ? at : null }),
        );
        return { id: current.id };
      }
      case "issue.delete": {
        const current = yield* issue();
        if (current.archivedAt === null)
          return yield* invalid("Archive an issue before deleting it.");
        const file = issuePath(state, current.id);
        yield* fs.remove(file).pipe(Effect.catch(io(`Could not remove ${file}.`)));
        state.issues.delete(current.id);
        return { id: current.id };
      }
      case "decision.create": {
        const category = w.category ?? "general";
        const title = yield* need(w.title, "title");
        // An agent hands on its reasoning, not only the outcome.
        if (actor !== "user" && (w.why ?? "").trim().length === 0)
          return yield* invalid(
            "why is required for decision.create: say why this was chosen over the alternatives.",
          );
        const initial = w.state ?? "accepted";
        if (initial === "superseded") return yield* invalid(SUPERSEDE_ONLY);
        const list = state.decisions.get(category) ?? [];
        const id = Files.uniqueSlug(Files.slugOf(title), (slug) => list.some((d) => d.id === slug));
        yield* saveDecisions(state, category, [
          ...list,
          {
            category,
            id,
            state: initial,
            title,
            why: w.why ?? "",
            alternatives: w.alternatives ?? [],
            reconsiderWhen: nullIfBlank(w.reconsiderWhen),
            supersedes: [],
            supersededBy: null,
            issues: w.issues ?? [],
            // The thread an agent decides in is where the decision was made.
            threads: [...new Set([...(w.threads ?? []), ...actorThreads(actor)])],
            by: actor,
            at,
            revisions: [{ at, by: actor, change: `created: ${initial}` }],
          },
        ]);
        return { id };
      }
      case "decision.update": {
        const { category, list, index } = yield* decision();
        if (w.state !== undefined)
          return yield* invalid("decision.update leaves the state alone; use decision.setState.");
        const current = list[index]!;
        const next: KanbanDecision = {
          ...current,
          ...(w.title === undefined ? {} : { title: w.title }),
          ...(w.why === undefined ? {} : { why: w.why }),
          ...(w.alternatives === undefined ? {} : { alternatives: w.alternatives }),
          ...(w.reconsiderWhen === undefined
            ? {}
            : { reconsiderWhen: nullIfBlank(w.reconsiderWhen) }),
          ...(w.issues === undefined ? {} : { issues: w.issues }),
          ...(w.threads === undefined ? {} : { threads: w.threads }),
        };
        const changed = EDITABLE.filter(
          (field) => JSON.stringify(next[field]) !== JSON.stringify(current[field]),
        );
        // Nothing to record: no write, so no revision.
        if (changed.length === 0) return { id: current.id };
        yield* saveDecisions(
          state,
          category,
          list.with(index, revised(next, `edited: ${changed.join(", ")}`)),
        );
        return { id: current.id };
      }
      case "decision.setState": {
        const { category, list, index } = yield* decision();
        const to = yield* need(w.state, "state");
        if (to === "superseded") return yield* invalid(SUPERSEDE_ONLY);
        const current = list[index]!;
        if (current.state === to) return { id: current.id };
        const replacement = current.supersededBy;
        const ref = Files.decisionRef(current);
        // Leaving superseded unlinks both sides, so the replacement no longer claims it.
        yield* saveLinked(
          {
            category,
            index,
            next: revised(
              { ...current, state: to, supersededBy: null },
              `state: ${current.state} → ${to}${
                replacement === null ? "" : `; no longer superseded by ${replacement}`
              }`,
            ),
          },
          replacement === null
            ? null
            : {
                ref: replacement,
                change: (found) =>
                  revised(
                    { ...found, supersedes: found.supersedes.filter((r) => r !== ref) },
                    `no longer supersedes ${ref}`,
                  ),
              },
        );
        return { id: current.id };
      }
      case "decision.supersede": {
        const { category, list, index } = yield* decision();
        const by = yield* need(w.by, "by");
        const current = list[index]!;
        const ref = Files.decisionRef(current);
        if (by === ref) return yield* invalid("A decision cannot supersede itself.");
        if (current.state === "superseded" && current.supersededBy !== by)
          return yield* invalid(
            `${ref} is already superseded by ${current.supersededBy ?? "another"}.`,
          );
        const other = findRef(by);
        if (other === null) return yield* notFound(`No decision "${by}".`);
        const replacement = other.list[other.index]!;
        if (replacement.state === "superseded")
          return yield* invalid(
            `${by} is itself superseded by ${replacement.supersededBy ?? "another"}; supersede with that.`,
          );
        // A retry after the replacement's file failed: the link holds, its revision may not.
        const linked = current.state === "superseded";
        const recorded =
          replacement.revisions.findLast(
            (r) => r.change === `supersedes ${ref}` || r.change === `no longer supersedes ${ref}`,
          )?.change === `supersedes ${ref}`;
        if (linked && recorded) return { id: current.id };
        yield* saveLinked(
          linked
            ? null
            : {
                category,
                index,
                next: revised(
                  { ...current, state: "superseded", supersededBy: by },
                  `state: ${current.state} → superseded by ${by}`,
                ),
              },
          recorded
            ? null
            : {
                ref: by,
                change: (found) =>
                  revised(
                    { ...found, supersedes: [...found.supersedes.filter((r) => r !== ref), ref] },
                    `supersedes ${ref}`,
                  ),
              },
        );
        return { id: current.id };
      }
      case "decision.delete": {
        if (actor !== "user")
          return yield* new KanbanError({
            code: "gated",
            message: "Agents supersede or reject a decision; only a person deletes one.",
          });
        const { category, list, index } = yield* decision();
        const current = list[index]!;
        if (current.supersededBy !== null || current.supersedes.length > 0)
          return yield* invalid(
            `${Files.decisionRef(current)} is linked by supersession; set the superseded decision's state to unlink it first.`,
          );
        yield* saveDecisions(state, category, list.toSpliced(index, 1));
        return { id: current.id };
      }
    }
  });

  const sweepProject = Effect.fn("KanbanStore.sweepProject")(function* (
    projectId: ProjectId,
    state: Loaded,
  ) {
    const now = yield* DateTime.now;
    const cutoff = DateTime.formatIso(DateTime.subtractDuration(now, ARCHIVE_AFTER));
    const at = DateTime.formatIso(now);
    const stale = Array.from(state.issues.values()).filter(
      (issue) =>
        issue.status === "done" &&
        issue.archivedAt === null &&
        issue.doneAt !== null &&
        issue.doneAt <= cutoff,
    );
    if (stale.length === 0) return;
    yield* state.lock.withPermits(1)(
      Effect.forEach(stale, (issue) => saveIssue(state, { ...issue, archivedAt: at }), {
        discard: true,
      }),
    );
    yield* publish(projectId);
  });

  const subscribeBoard: KanbanStore["Service"]["subscribeBoard"] = (projectId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before the first snapshot so a change between the two is buffered, not lost.
        const subscription = yield* PubSub.subscribe(yield* changesOf(projectId));
        const first = yield* load(projectId);
        return Stream.concat(
          Stream.succeed(board(first)),
          Stream.fromSubscription(subscription).pipe(
            Stream.mapEffect(() => Effect.map(load(projectId), board)),
          ),
        );
      }),
    );

  const write: KanbanStore["Service"]["write"] = Effect.fn("KanbanStore.write")(
    function* (projectId, actor, w) {
      const state = yield* load(projectId);
      const { reopened, ...result } = yield* state.lock.withPermits(1)(applyWrite(state, actor, w));
      yield* publish(projectId);
      // A done issue coming back is a correction for the learning plugin, recorded outside the lock.
      if (reopened !== undefined) yield* recordTicketReopen(projectId, reopened);
      return result;
    },
  );

  const advance: KanbanStore["Service"]["advance"] = Effect.fn("KanbanStore.advance")(
    function* (projectId, threadId, status) {
      // Thread events arrive for every project; only one with a board folder is worth loading.
      if (!loaded.has(projectId)) {
        const { directory } = yield* resolveDirectory(projectId);
        if (!(yield* fs.exists(directory).pipe(Effect.orElseSucceed(() => false)))) return;
      }
      const state = yield* load(projectId);
      const linked = Array.from(state.issues.values()).filter(
        (issue) =>
          issue.threads.some((link) => link.id === threadId) &&
          !HOLDING.has(issue.status) &&
          rank(status) > rank(issue.status) &&
          // Done keeps its definition: open criteria hold the card in review.
          !(status === "done" && issue.criteria.some((c) => !c.checked)),
      );
      if (linked.length === 0) return;
      const at = yield* nowIso;
      yield* state.lock.withPermits(1)(
        Effect.forEach(linked, (issue) => saveIssue(state, moved(issue, status, "system", at)), {
          discard: true,
        }),
      );
      yield* publish(projectId);
    },
  );

  const admit: KanbanStore["Service"]["admit"] = Effect.fn("KanbanStore.admit")(
    function* (projectId, id, by, texts, sourceHash) {
      const state = yield* load(projectId);
      const outcome = yield* state.lock.withPermits(1)(
        Effect.gen(function* () {
          const current = state.issues.get(id);
          if (current === undefined) return yield* notFound(`No issue "${id}".`);
          // Before the column check: an issue edited and moved on meanwhile is `changed`, not `left`.
          if (hashSource(current) !== sourceHash) return "changed" as const;
          if (!HOLDING.has(current.status)) return "left" as const;
          const at = yield* nowIso;
          // In the given order; an existing criterion with the same text keeps its id and state.
          const unused = [...current.criteria];
          let next = nextCriterionNumber(current.criteria);
          const criteria = texts.map((text) => {
            const index = unused.findIndex((c) => c.text === text);
            return index === -1
              ? { id: `c${next++}`, text, checked: false }
              : unused.splice(index, 1)[0]!;
          });
          const added = criteria.filter((c) => !current.criteria.includes(c));
          const amended: KanbanIssue = {
            ...current,
            criteria,
            log: [
              ...current.log,
              ...unused.map((c) => ({
                at,
                by,
                kind: "criterion" as const,
                text: `removed: ${c.text}`,
              })),
              ...added.map((c) => ({
                at,
                by,
                kind: "criterion" as const,
                text: `added: ${c.text}`,
              })),
            ],
          };
          yield* saveIssue(state, moved(amended, "todo", by, at));
          return "admitted" as const;
        }),
      );
      if (outcome === "admitted") yield* publish(projectId);
      return outcome;
    },
  );

  const transact: KanbanStore["Service"]["transact"] = (projectId, change) =>
    Effect.gen(function* () {
      const state = yield* load(projectId);
      const { result, save } = yield* state.lock.withPermits(1)(
        Effect.flatMap(nowIso, (at) => change(state.issues, at)).pipe(
          Effect.tap(({ save }) =>
            Effect.forEach(save, (issue) => saveIssue(state, issue), { discard: true }),
          ),
        ),
      );
      if (save.length > 0) yield* publish(projectId);
      return result;
    });

  const writeOverrides = (overrides: typeof Overrides.Type) =>
    encodeOverrides(overrides).pipe(
      Effect.catch(io("Could not encode kanban.json.")),
      Effect.flatMap((contents) =>
        writeFileStringAtomically({ filePath: overridesPath, contents: `${contents}\n` }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.catch(io(`Could not write ${overridesPath}.`)),
        ),
      ),
    );

  const updateOverrides = (change: (overrides: typeof Overrides.Type) => typeof Overrides.Type) =>
    overridesLock.withPermits(1)(
      Effect.flatMap(readOverrides, (overrides) => writeOverrides(change(overrides))),
    );

  const setCapture: KanbanStore["Service"]["setCapture"] = Effect.fn("KanbanStore.setCapture")(
    function* ({ projectId, enabled }) {
      yield* updateOverrides((overrides) => {
        const others = (overrides.capture ?? []).filter((id) => id !== projectId);
        return { ...overrides, capture: enabled ? [...others, projectId] : others };
      });
      const state = loaded.get(projectId);
      if (state !== undefined) state.capture = enabled;
      yield* publish(projectId);
    },
  );

  const setDirectory: KanbanStore["Service"]["setDirectory"] = Effect.fn(
    "KanbanStore.setDirectory",
  )(function* ({ projectId, directory }) {
    if (directory !== null && !path.isAbsolute(directory))
      return yield* invalid("The issues folder must be an absolute path.");
    yield* updateOverrides((overrides) => {
      const directories: Record<string, string> = { ...overrides.directories };
      if (directory === null) delete directories[projectId];
      else directories[projectId] = directory;
      return { ...overrides, directories };
    });
    const previous = loaded.get(projectId);
    if (previous !== undefined) {
      loaded.delete(projectId);
      yield* Scope.close(previous.scope, Exit.void);
    }
    yield* publish(projectId);
  });

  yield* Effect.addFinalizer(() =>
    Effect.forEach(loaded.values(), (state) => Scope.close(state.scope, Exit.void), {
      discard: true,
    }),
  );

  return KanbanStore.of({
    subscribeBoard,
    getIssue: ({ projectId, id }) =>
      Effect.flatMap(load(projectId), (state) => {
        const issue = state.issues.get(id);
        return issue === undefined
          ? Effect.fail(notFound(`No issue "${id}".`))
          : Effect.succeed(issue);
      }),
    listDecisions: ({ projectId, category, issue, state: wanted, query }) =>
      Effect.map(load(projectId), (state) => {
        const listed = Array.from(state.decisions.values())
          .flat()
          .filter(
            (d) =>
              (category === undefined || d.category === category) &&
              (issue === undefined || d.issues.includes(issue)) &&
              (wanted === undefined || d.state === wanted),
          );
        return query === undefined ? listed : search(listed, query);
      }),
    write,
    setDirectory,
    setCapture,
    captures: (projectId) =>
      Effect.map(readOverrides, (overrides) => overrides.capture?.includes(projectId) ?? false),
    admit,
    advance,
    sweepArchive: Effect.forEach(loaded, ([projectId, state]) => sweepProject(projectId, state), {
      discard: true,
    }).pipe(Effect.catch((cause) => Effect.logWarning("kanban: archive sweep failed", { cause }))),
    board: (projectId) => Effect.map(load(projectId), board),
    directory: (projectId) => Effect.map(resolveDirectory(projectId), ({ directory }) => directory),
    linkedProject: (threadId) =>
      Effect.sync(() => {
        for (const [projectId, state] of loaded)
          for (const issue of state.issues.values())
            if (issue.threads.some((link) => link.id === threadId)) return projectId;
        return undefined;
      }),
    loadedDecisions: Effect.sync(
      () =>
        new Map(
          Array.from(loaded, ([projectId, state]) => [
            projectId,
            Array.from(state.decisions.values()).flat(),
          ]),
        ),
    ),
    transact,
  });
});

export const layer = Layer.effect(KanbanStore, make);
