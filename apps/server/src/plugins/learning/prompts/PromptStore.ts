import {
  LearningError,
  PROMPT_PREVIEW_LENGTH,
  PROMPT_VERSIONS_LIMIT,
  PROMPTS_LIST_LIMIT,
  PromptBody,
  promptQueryWords,
  PromptTitle,
  type ProjectId,
  type Prompt,
  type PromptDetail,
  type PromptKind,
  type PromptOrigin,
  type PromptSearchResult,
  type PromptState,
  type PromptSummary,
  type PromptsCreateInput,
  type PromptsEditInput,
  type PromptsListInput,
  type PromptsRevertInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

/** How long after a search an agent may save from it. */
export const SEARCH_WINDOW_MINUTES = 15;
/** The most matches a search answers with. */
const SEARCH_LIMIT = 10;

interface Row {
  readonly id: number;
  readonly project_id: ProjectId;
  readonly kind: PromptKind;
  readonly state: PromptState;
  readonly origin: PromptOrigin;
  readonly title: string;
  readonly body: string;
  readonly version: number;
  readonly use_count: number;
  readonly last_used_at: string | null;
  readonly accepted_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** A row as lists and searches read it: the start of the body, never all of it. */
type SummaryRow = Omit<Row, "body" | "accepted_at"> & { readonly preview: string };

const fields = (row: Omit<SummaryRow, "preview">) => ({
  id: row.id,
  projectId: row.project_id,
  kind: row.kind,
  state: row.state,
  origin: row.origin,
  title: row.title,
  version: row.version,
  useCount: row.use_count,
  lastUsedAt: row.last_used_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toPrompt = (row: Row): Prompt => ({ ...fields(row), body: row.body });

const toSummary = (row: SummaryRow): PromptSummary => ({ ...fields(row), preview: row.preview });

/** The text of a new prompt, before the store gives it a state and an origin. */
interface PromptText {
  readonly projectId: ProjectId;
  readonly kind: PromptKind;
  readonly title: string;
  readonly body: string;
}

const invalid = (message: string) => new LearningError({ code: "invalid", message });
const isTitle = Schema.is(PromptTitle);
const isBody = Schema.is(PromptBody);

/** The contract's limits, for callers inside the server that did not decode their text. */
const checkText = (title: string, body: string) =>
  !isTitle(title)
    ? Effect.fail(invalid("A title is one line of at most 200 characters."))
    : !isBody(body)
      ? Effect.fail(invalid("A body is between 1 and 10,000 characters."))
      : Effect.void;

/**
 * Saved prompts and workflows, per project, versioned. A person's save is active at once; an
 * agent's is proposed, and only after a recent search, so it has looked for a duplicate first; a
 * sweep's is proposed once per source. A person accepts, edits, reverts, archives and unarchives.
 */
export class PromptStore extends Context.Service<
  PromptStore,
  {
    /**
     * A project's prompts as summaries, the most recently updated first, at most
     * `PROMPTS_LIST_LIMIT`, narrowed by state and by the words of `query` as `search` matches them.
     */
    readonly list: (
      input: PromptsListInput,
    ) => Effect.Effect<ReadonlyArray<PromptSummary>, LearningError>;
    /** One prompt with its latest body and its latest versions, newest first, as previews. */
    readonly get: (id: number) => Effect.Effect<PromptDetail, LearningError>;
    /**
     * The project's prompts in every state, as summaries, whose title or body holds each word of
     * `query`, in any case for ASCII letters; a blank query matches all. Active first, then
     * proposed, then archived, the most used first within each, at most ten. The search id it
     * answers with lets a `propose` save in that project for the next 15 minutes. Searches are
     * kept in memory, so a restart forgets them.
     */
    readonly search: (input: {
      readonly projectId: ProjectId;
      readonly query: string;
    }) => Effect.Effect<PromptSearchResult, LearningError>;
    /** A person's save: active at once, with origin `user`. */
    readonly create: (input: PromptsCreateInput) => Effect.Effect<Prompt, LearningError>;
    /**
     * An agent's save: proposed, with origin `user`, in the project `searchId` searched. Refused
     * without a search from the last 15 minutes.
     */
    readonly propose: (input: {
      readonly searchId: string;
      readonly kind: PromptKind;
      readonly title: string;
      readonly body: string;
    }) => Effect.Effect<Prompt, LearningError>;
    /**
     * A proposal from a sweep, once per project and `sourceKey`, such as `promotion:<id>`. Looking
     * for the key and saving are one transaction, so overlapping calls save one prompt, and a
     * repeat answers with the prompt the key saved in that project, whatever became of it since.
     */
    readonly proposeFrom: (
      input: PromptText & {
        readonly origin: Exclude<PromptOrigin, "user">;
        readonly sourceKey: string;
      },
    ) => Effect.Effect<Prompt, LearningError>;
    /** Adds a version with this text, in any state; the latest version's text again adds none. */
    readonly edit: (input: PromptsEditInput) => Effect.Effect<Prompt, LearningError>;
    /** Adds a copy of an earlier version as the next version, as `edit` would. */
    readonly revert: (input: PromptsRevertInput) => Effect.Effect<Prompt, LearningError>;
    /**
     * A proposed prompt becomes active. Like the other moves it is one conditional update, so of
     * two requests for one prompt the second is refused.
     */
    readonly accept: (id: number) => Effect.Effect<Prompt, LearningError>;
    /** An active or proposed prompt is put away. */
    readonly archive: (id: number) => Effect.Effect<Prompt, LearningError>;
    /** An archived prompt is active again once a person accepted or saved it, else proposed. */
    readonly unarchive: (id: number) => Effect.Effect<Prompt, LearningError>;
    /** Counts one use and stamps when, in any state. */
    readonly use: (id: number) => Effect.Effect<Prompt, LearningError>;
  }
>()("t3/plugins/learning/prompts/PromptStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  /** Search id to the project it searched and the epoch millisecond it stops letting a save in. */
  const searches = new Map<string, { readonly projectId: ProjectId; readonly until: number }>();

  const io = (cause: SqlError.SqlError) =>
    Effect.logWarning("learning: prompt library operation failed", { cause }).pipe(
      Effect.andThen(
        Effect.fail(
          new LearningError({
            code: "io",
            message: "The prompt library could not be read or written.",
          }),
        ),
      ),
    );
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const notFound = (id: number) =>
    new LearningError({ code: "not_found", message: `No prompt ${id}.` });
  const existing = (id: number) =>
    sql<Row>`SELECT * FROM prompts WHERE id = ${id}`.pipe(
      Effect.flatMap(([row]) =>
        row === undefined ? Effect.fail(notFound(id)) : Effect.succeed(row),
      ),
    );

  /** The columns of a summary row. */
  const summaryColumns = sql`id, project_id, kind, state, origin, title,
    substr(body, 1, ${PROMPT_PREVIEW_LENGTH}) AS preview, version, use_count, last_used_at,
    created_at, updated_at`;
  /**
   * One condition per word `promptQueryWords` keeps: the title or body holds it. SQLite's `lower`
   * folds ASCII letters only, and it folds both sides, so other letters match as typed.
   */
  const matching = (query: string) =>
    promptQueryWords(query).map(
      (word) => sql`instr(lower(title || char(10) || body), lower(${word})) > 0`,
    );

  /** Inserts a prompt and its first version; with a source key, the prompt it saved before instead. */
  const insert = (
    text: PromptText,
    state: PromptState,
    origin: PromptOrigin,
    sourceKey: string | null,
  ) =>
    Effect.gen(function* () {
      yield* checkText(text.title, text.body);
      const at = yield* nowIso;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          if (sourceKey !== null) {
            const [saved] = yield* sql<Row>`SELECT * FROM prompts
              WHERE project_id = ${text.projectId} AND source_key = ${sourceKey}`;
            if (saved !== undefined) return toPrompt(saved);
          }
          const [row] = yield* sql<Row>`INSERT INTO prompts ${sql.insert({
            project_id: text.projectId,
            kind: text.kind,
            state,
            origin,
            title: text.title,
            body: text.body,
            version: 1,
            use_count: 0,
            last_used_at: null,
            source_key: sourceKey,
            accepted_at: state === "active" ? at : null,
            created_at: at,
            updated_at: at,
          })} RETURNING *`;
          yield* sql`INSERT INTO prompt_versions ${sql.insert({
            prompt_id: row!.id,
            version: 1,
            title: text.title,
            body: text.body,
            created_at: at,
          })}`;
          return toPrompt(row!);
        }),
      );
    }).pipe(Effect.catchTags({ SqlError: io }));

  /** The next version with this text, unless it is the latest version's text already. */
  const addVersion = (id: number, title: string, body: string) =>
    Effect.gen(function* () {
      yield* checkText(title, body);
      const at = yield* nowIso;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const current = yield* existing(id);
          if (current.title === title && current.body === body) return toPrompt(current);
          const version = current.version + 1;
          yield* sql`INSERT INTO prompt_versions ${sql.insert({
            prompt_id: id,
            version,
            title,
            body,
            created_at: at,
          })}`;
          const [row] = yield* sql<Row>`UPDATE prompts
            SET title = ${title}, body = ${body}, version = ${version}, updated_at = ${at}
            WHERE id = ${id}
            RETURNING *`;
          return toPrompt(row!);
        }),
      );
    }).pipe(Effect.catchTags({ SqlError: io }));

  /** A move made by `update`, which returns no row when the prompt is not in a state it moves from. */
  const move = (
    id: number,
    only: string,
    update: (at: string) => Effect.Effect<ReadonlyArray<Row>, SqlError.SqlError>,
  ) =>
    Effect.gen(function* () {
      const [moved] = yield* update(yield* nowIso);
      if (moved !== undefined) return toPrompt(moved);
      const current = yield* existing(id);
      return yield* invalid(`Prompt ${id} is ${current.state}; only ${only}.`);
    }).pipe(Effect.catchTags({ SqlError: io }));

  const list: PromptStore["Service"]["list"] = ({ projectId, state, query }) =>
    sql<SummaryRow>`SELECT ${summaryColumns} FROM prompts
      WHERE ${sql.and([
        sql`project_id = ${projectId}`,
        ...(state === undefined ? [] : [sql`state = ${state}`]),
        ...matching(query ?? ""),
      ])}
      ORDER BY updated_at DESC, id DESC
      LIMIT ${PROMPTS_LIST_LIMIT}`.pipe(
      Effect.map((rows) => rows.map(toSummary)),
      Effect.catchTags({ SqlError: io }),
    );

  const get: PromptStore["Service"]["get"] = (id) =>
    Effect.gen(function* () {
      const prompt = yield* existing(id);
      const versions = yield* sql<{
        readonly version: number;
        readonly title: string;
        readonly preview: string;
        readonly created_at: string;
      }>`SELECT version, title, substr(body, 1, ${PROMPT_PREVIEW_LENGTH}) AS preview, created_at
        FROM prompt_versions
        WHERE prompt_id = ${id}
        ORDER BY version DESC
        LIMIT ${PROMPT_VERSIONS_LIMIT}`;
      return {
        prompt: toPrompt(prompt),
        versions: versions.map((v) => ({
          version: v.version,
          title: v.title,
          preview: v.preview,
          createdAt: v.created_at,
        })),
      };
      // One snapshot, so the versions listed end at the prompt's own version.
    }).pipe(sql.withTransaction, Effect.catchTags({ SqlError: io }));

  const search: PromptStore["Service"]["search"] = ({ projectId, query }) =>
    Effect.gen(function* () {
      const rows = yield* sql<SummaryRow>`SELECT ${summaryColumns} FROM prompts
        WHERE ${sql.and([sql`project_id = ${projectId}`, ...matching(query)])}
        ORDER BY CASE state WHEN 'active' THEN 0 WHEN 'proposed' THEN 1 ELSE 2 END,
          use_count DESC, updated_at DESC, id DESC
        LIMIT ${SEARCH_LIMIT}`;
      const searchId = yield* crypto.randomUUIDv4();
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      for (const [id, entry] of searches) if (entry.until <= now) searches.delete(id);
      searches.set(searchId, { projectId, until: now + SEARCH_WINDOW_MINUTES * 60_000 });
      return { searchId, prompts: rows.map(toSummary) };
    }).pipe(
      Effect.catchTags({
        SqlError: io,
        PlatformError: (cause) =>
          Effect.logWarning("learning: could not make a search id", { cause }).pipe(
            Effect.andThen(
              Effect.fail(
                new LearningError({ code: "io", message: "The search could not be recorded." }),
              ),
            ),
          ),
      }),
    );

  const create: PromptStore["Service"]["create"] = (input) => insert(input, "active", "user", null);

  const propose: PromptStore["Service"]["propose"] = ({ searchId, ...text }) =>
    Effect.gen(function* () {
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const search = searches.get(searchId);
      if (search === undefined || search.until <= now) {
        return yield* invalid(
          `Search the prompt library first: a save needs the searchId of a search made in the last ${SEARCH_WINDOW_MINUTES} minutes, so it does not duplicate a saved prompt.`,
        );
      }
      return yield* insert({ projectId: search.projectId, ...text }, "proposed", "user", null);
    });

  const proposeFrom: PromptStore["Service"]["proposeFrom"] = ({ origin, sourceKey, ...text }) =>
    insert(text, "proposed", origin, sourceKey);

  const edit: PromptStore["Service"]["edit"] = ({ id, title, body }) => addVersion(id, title, body);

  const revert: PromptStore["Service"]["revert"] = ({ id, version }) =>
    Effect.gen(function* () {
      yield* existing(id);
      const [earlier] = yield* sql<{ readonly title: string; readonly body: string }>`
        SELECT title, body FROM prompt_versions WHERE prompt_id = ${id} AND version = ${version}`;
      if (earlier === undefined) return yield* invalid(`Prompt ${id} has no version ${version}.`);
      return yield* addVersion(id, earlier.title, earlier.body);
    }).pipe(Effect.catchTags({ SqlError: io }));

  const accept: PromptStore["Service"]["accept"] = (id) =>
    move(
      id,
      "a proposed prompt is accepted",
      (at) => sql<Row>`UPDATE prompts SET state = 'active', accepted_at = ${at}, updated_at = ${at}
        WHERE id = ${id} AND state = 'proposed'
        RETURNING *`,
    );

  const archive: PromptStore["Service"]["archive"] = (id) =>
    move(
      id,
      "an active or proposed prompt is archived",
      (at) => sql<Row>`UPDATE prompts SET state = 'archived', updated_at = ${at}
        WHERE id = ${id} AND state <> 'archived'
        RETURNING *`,
    );

  const unarchive: PromptStore["Service"]["unarchive"] = (id) =>
    move(
      id,
      "an archived prompt is unarchived",
      (at) => sql<Row>`UPDATE prompts
        SET state = CASE WHEN accepted_at IS NULL THEN 'proposed' ELSE 'active' END,
          updated_at = ${at}
        WHERE id = ${id} AND state = 'archived'
        RETURNING *`,
    );

  const use: PromptStore["Service"]["use"] = (id) =>
    Effect.gen(function* () {
      const at = yield* nowIso;
      const [row] = yield* sql<Row>`UPDATE prompts
        SET use_count = use_count + 1, last_used_at = ${at}
        WHERE id = ${id}
        RETURNING *`;
      if (row === undefined) return yield* notFound(id);
      return toPrompt(row);
    }).pipe(Effect.catchTags({ SqlError: io }));

  return PromptStore.of({
    list,
    get,
    search,
    create,
    propose,
    proposeFrom,
    edit,
    revert,
    accept,
    archive,
    unarchive,
    use,
  });
});

export const layer = Layer.effect(PromptStore, make);
