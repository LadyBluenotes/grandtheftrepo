import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as SqlError from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as HostDatabase from "./HostDatabase.ts";

/** What the person should do about a flag: a label and the screen it leads to (issue #30). */
const ResumeAction = Schema.Struct({
  label: Schema.String,
  target: Schema.Literals(["thread", "board", "settings"]),
});
const encodeResumeAction = Schema.encodeSync(Schema.fromJsonString(ResumeAction));

const AttentionKind = Schema.Literals([
  "budget_breach",
  "routing_mismatch",
  "two_writers",
  "stale_review",
  "security_hold",
  "unowned_finding",
  "delivery_drift",
  "promotion_ineffective",
  "promotion_settled",
]);
type AttentionKind = typeof AttentionKind.Type;

/** An open flag with what a person needs to act on it; `raisedAt` is when it was first raised. */
const OpenFlag = Schema.Struct({
  id: Schema.Int,
  pluginId: Schema.String,
  threadId: Schema.String,
  kind: AttentionKind,
  text: Schema.String,
  resumeAction: Schema.fromJsonString(ResumeAction),
  raisedAt: Schema.String,
});
export type OpenFlag = typeof OpenFlag.Type;

interface FlagKey {
  readonly pluginId: string;
  readonly threadId: string;
  readonly kind: AttentionKind;
}

/**
 * Things waiting on a person, raised and cleared by any plugin's sweep without depending on the
 * plugin that shows them. Only the raising plugin clears its flags, once the cause is gone; a
 * cleared flag is kept as history.
 */
export class Attention extends Context.Service<
  Attention,
  {
    /** Opens a flag, or rewrites the text and action of the one already open for the same key. */
    readonly raise: (
      flag: FlagKey & {
        readonly text: string;
        readonly resumeAction: typeof ResumeAction.Type;
      },
    ) => Effect.Effect<void, SqlError.SqlError>;
    /** Clears the open flag for the key; succeeds when none is open. */
    readonly clear: (flag: FlagKey) => Effect.Effect<void, SqlError.SqlError>;
    /**
     * Open flags, oldest first. A sweep narrows them to its own plugin and kind to reconcile
     * against; a report reads them all.
     */
    readonly listOpen: (input: {
      readonly pluginId?: string | undefined;
      readonly kind?: AttentionKind | undefined;
    }) => Effect.Effect<
      ReadonlyArray<{ readonly threadId: string; readonly text: string }>,
      SqlError.SqlError
    >;

    /** Every plugin's open flags, oldest first, for the screen that shows them. */
    readonly listAllOpen: Effect.Effect<
      ReadonlyArray<OpenFlag>,
      SqlError.SqlError | Schema.SchemaError
    >;
  }
>()("t3/plugins/Attention") {}

const make = Effect.gen(function* () {
  const sql = yield* HostDatabase.HostDatabase;

  const raise: Attention["Service"]["raise"] = (flag) =>
    Effect.gen(function* () {
      const raisedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO attention (plugin_id, thread_id, kind, text, resume_action, raised_at)
        VALUES (${flag.pluginId}, ${flag.threadId}, ${flag.kind}, ${flag.text}, ${encodeResumeAction(flag.resumeAction)}, ${raisedAt})
        ON CONFLICT (plugin_id, thread_id, kind) WHERE cleared_at IS NULL
        DO UPDATE SET text = excluded.text, resume_action = excluded.resume_action
      `;
    });

  const clear: Attention["Service"]["clear"] = (flag) =>
    Effect.gen(function* () {
      const clearedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        UPDATE attention SET cleared_at = ${clearedAt}
        WHERE plugin_id = ${flag.pluginId} AND thread_id = ${flag.threadId}
          AND kind = ${flag.kind} AND cleared_at IS NULL
      `;
    });

  const listOpen: Attention["Service"]["listOpen"] = ({ pluginId, kind }) =>
    sql<{ readonly thread_id: string; readonly text: string }>`
      SELECT thread_id, text FROM attention
      WHERE cleared_at IS NULL
        ${pluginId === undefined ? sql`` : sql`AND plugin_id = ${pluginId}`}
        ${kind === undefined ? sql`` : sql`AND kind = ${kind}`}
      ORDER BY id
    `.pipe(Effect.map((rows) => rows.map((row) => ({ threadId: row.thread_id, text: row.text }))));

  const listAllOpen = SqlSchema.findAll({
    Request: Schema.Void,
    Result: OpenFlag,
    execute: () => sql`
      SELECT id, plugin_id AS "pluginId", thread_id AS "threadId", kind, text,
        resume_action AS "resumeAction", raised_at AS "raisedAt"
      FROM attention WHERE cleared_at IS NULL
      ORDER BY id
    `,
  })(undefined);

  return Attention.of({ raise, clear, listOpen, listAllOpen });
});

export const layer = Layer.effect(Attention, make);

/**
 * Brings `pluginId`'s open flags of `kind` in line with what a tick found. `judged` maps a flag's
 * key to the sentence for a cause that stands, or to undefined for one that is gone; a flag is
 * raised for the first, cleared for the second, and rewritten only when its sentence changed, so a
 * tick that finds what the last one found writes nothing. An open flag whose key was not judged
 * belongs to a cause the plugin no longer tracks, and is cleared, unless `leave` names it: a cause
 * the tick could not read keeps whatever flag it had. A dry run changes nothing. `changes` counts
 * the raises, rewrites and clears, and `standing` the flags that stand after them.
 */
export const reconcile = Effect.fn("Attention.reconcile")(function* (
  attention: Attention["Service"],
  input: {
    readonly pluginId: string;
    readonly kind: AttentionKind;
    readonly resumeAction: typeof ResumeAction.Type;
    readonly dryRun: boolean;
    readonly judged: ReadonlyMap<string, string | undefined>;
    readonly leave: (key: string) => boolean;
  },
) {
  const open = new Map(
    (yield* attention.listOpen({ pluginId: input.pluginId, kind: input.kind })).map((flag) => [
      flag.threadId,
      flag.text,
    ]),
  );
  const flag = (key: string) =>
    ({ pluginId: input.pluginId, threadId: key, kind: input.kind }) as const;
  let changes = 0;
  let standing = 0;
  for (const [key, text] of input.judged) {
    if (text !== undefined) standing += 1;
    if (text === open.get(key)) continue;
    changes += 1;
    if (input.dryRun) continue;
    yield* text === undefined
      ? attention.clear(flag(key))
      : attention.raise({ ...flag(key), text, resumeAction: input.resumeAction });
  }
  for (const key of open.keys()) {
    if (input.judged.has(key)) continue;
    if (input.leave(key)) {
      standing += 1;
      continue;
    }
    changes += 1;
    if (!input.dryRun) yield* attention.clear(flag(key));
  }
  return { changes, standing };
});
