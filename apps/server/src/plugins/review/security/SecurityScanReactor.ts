import type { OrchestrationV2Checkpoint, OrchestrationV2Run, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import * as CheckpointDiffQuery from "../../../checkpointing/CheckpointDiffQuery.ts";
import type { CheckpointServiceError } from "../../../checkpointing/Errors.ts";
import type * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Attention from "../../Attention.ts";
import * as CorrectionStore from "../../learning/CorrectionStore.ts";
import * as PluginReactor from "../../PluginReactor.ts";
import * as PluginSupervisor from "../../PluginSupervisor.ts";
import { type Match, scan } from "./patterns.ts";
import {
  type FindingRow,
  flagKey,
  holdOf,
  holdText,
  modeOf,
  RESUME_ACTION,
} from "./SecurityHold.ts";

/** Findings one sweep tick records corrections for; the rest wait for the next tick. */
const BATCH_SIZE = 100;

/**
 * Run statuses whose checkpoint `getTurnDiff` cannot diff to: it keeps completed runs only. A
 * rolled-back run is not here; its work is gone and there is nothing to scan.
 */
const UNREADABLE_RUNS: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "interrupted",
  "cancelled",
  "failed",
]);

/** What a turn the scan could not read records in a `block` project, so the thread is held. */
const SCAN_FAILED: ReadonlyArray<Match> = [{ patternId: "scan_failed", file: "", line: 0 }];

/**
 * The diff of the turn ending at `ordinal`, from the turn before it. `getTurnDiff` covers completed
 * runs only, so a stopped turn has no checkpoint to diff from, and the diff starts at the last one
 * before it that has, taking in the stopped turn's lines too. Empty when this turn, completed when
 * it was captured, has no checkpoint to diff to any more: it was rolled back since.
 */
const turnDiff = Effect.fn("SecurityScanReactor.turnDiff")(function* (
  diffs: CheckpointDiffQuery.CheckpointDiffQuery["Service"],
  threadId: ThreadId,
  ordinal: number,
) {
  for (let from = ordinal - 1; from >= 0; from--) {
    // Whitespace counts: an indentation change can move a line under a workflow's `run:`.
    const diff = yield* diffs
      .getTurnDiff({ threadId, fromTurnCount: from, toTurnCount: ordinal, ignoreWhitespace: false })
      .pipe(
        Effect.map((turn) => turn.diff),
        Effect.catchTags({
          CheckpointRefUnavailableError: (error) =>
            Effect.succeed(error.checkpoint === "from" ? null : ""),
          CheckpointTurnRangeUnavailableError: () => Effect.succeed(""),
          CheckpointThreadNotFoundError: () => Effect.succeed(""),
        }),
      );
    if (diff !== null) return diff;
  }
  return "";
});

/**
 * Scans each root-run checkpoint's turn: the lines its diff adds, against the fixed patterns, unless
 * the project's mode is `off`. A match is stored once per checkpoint, pattern, file and line, so a
 * replayed event adds nothing. In `block` the thread's hold is open and its flag raised here; the
 * sweep raises it again should that write fail. Every ready checkpoint handled gets a
 * `security_scan` row in the same transaction, which `block` waits for before a review.
 */
export const handlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const attention = yield* Attention.Attention;

  /**
   * The matches on the lines the turn added, none when the checkpoint is not a root run's, or
   * undefined when the turn cannot be read: its run stopped or failed, and `getTurnDiff` covers
   * completed runs only.
   */
  const scanTurn = (threadId: ThreadId, checkpoint: OrchestrationV2Checkpoint, ordinal: number) =>
    Effect.gen(function* () {
      const { checkpointScopes, runs } = yield* threads.getThreadRecords(threadId, [
        "checkpointScopes",
        "runs",
      ]);
      const root = checkpointScopes.some(
        (scope) => scope.id === checkpoint.scopeId && scope.kind === "root_run",
      );
      if (!root) return [];
      const run = runs.find((candidate) => candidate.id === checkpoint.runId);
      if (run !== undefined && UNREADABLE_RUNS.has(run.status)) return undefined;
      // Read from the reactor fiber's context, which the server's chain gives it, rather than
      // required of the layer: that would put it in every plugin's requirements for this alone.
      const diffs = yield* Effect.serviceOption(CheckpointDiffQuery.CheckpointDiffQuery);
      if (Option.isNone(diffs)) {
        yield* Effect.logWarning("review: security scan skipped, no checkpoint diff query");
        return [];
      }
      return scan(yield* turnDiff(diffs.value, threadId, ordinal));
    });

  /**
   * Scans one ready checkpoint of `threadId` and stores what it found. A turn the scan cannot read
   * holds the thread in `block`; in `warn` a stopped or failed turn is passed over with a warning,
   * its lines scanned with the next completed turn's, and any other failure fails the event for the
   * sweep to retry. The project's mode is read now, as the scan runs: the moment the turn ended,
   * unless this is a retry of a failed scan.
   */
  const scanCheckpoint = (
    threadId: ThreadId,
    checkpoint: OrchestrationV2Checkpoint,
    occurredAt: DateTime.Utc,
  ) =>
    Effect.gen(function* () {
      const ordinal = checkpoint.appRunOrdinal;
      if (ordinal === null) return;
      const shell = yield* threads.getThreadShell(threadId);
      if (shell === null || shell.deletedAt !== null) return;
      const mode = yield* modeOf(sql, shell.projectId);
      if (mode === "off") return;
      const scanned = yield* scanTurn(threadId, checkpoint, ordinal).pipe(
        Effect.catch((cause) =>
          mode === "block"
            ? Effect.logWarning("review: security scan failed; holding the thread", {
                threadId,
                cause,
              }).pipe(Effect.as(undefined))
            : Effect.fail(cause),
        ),
      );
      if (scanned === undefined && mode === "warn") {
        return yield* Effect.logWarning(
          "review: security scan cannot read a turn that did not complete",
          {
            threadId,
            checkpointId: checkpoint.id,
          },
        );
      }
      const matches = scanned ?? SCAN_FAILED;
      if (matches.length === 0) return;

      const createdAt = DateTime.formatIso(occurredAt);
      yield* sql`INSERT INTO security_finding ${sql.insert(
        matches.map((match) => ({
          thread_id: threadId,
          checkpoint_id: checkpoint.id,
          pattern_id: match.patternId,
          file: match.file,
          line: match.line,
          blocking: mode === "block" ? 1 : 0,
          created_at: createdAt,
        })),
      )} ON CONFLICT (checkpoint_id, pattern_id, file, line) DO NOTHING`;
      if (mode !== "block") return;
      const open = yield* holdOf(sql, threadId);
      if (open === 0) return;
      yield* attention
        .raise({ ...flagKey(threadId), text: holdText(open), resumeAction: RESUME_ACTION })
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("review: could not raise a security hold flag", { cause }),
          ),
        );
    });

  const result: PluginReactor.Handlers<
    SqlError.SqlError | Orchestrator.OrchestratorV2Error | CheckpointServiceError
  > = {
    "checkpoint.captured": ({ event }) =>
      Effect.gen(function* () {
        const { threadId, payload: checkpoint } = event;
        if (checkpoint.status !== "ready" || checkpoint.threadId !== threadId) return;
        yield* scanCheckpoint(threadId, checkpoint, event.occurredAt);
        // Written with the findings, whatever the scan found or skipped, so `block` can tell a
        // scan still to come from one that found nothing.
        const scannedAt = DateTime.formatIso(yield* DateTime.now);
        yield* sql`INSERT INTO security_scan (checkpoint_id, thread_id, scanned_at)
          VALUES (${checkpoint.id}, ${threadId}, ${scannedAt})
          ON CONFLICT (checkpoint_id) DO NOTHING`;
      }),
  };
  return result;
});

/**
 * The correction's source key: the finding's own unique tuple, not its row id, so a review
 * database rebuilt from scratch never lands a new finding on an old correction. Each part is
 * encoded so no two findings share a key.
 */
const sourceKeyOf = (row: FindingRow) =>
  `security:${[row.thread_id, row.checkpoint_id, row.pattern_id, row.file, String(row.line)]
    .map(encodeURIComponent)
    .join(":")}`;

/**
 * Records when the scan began, in the transaction that creates the reactor's cursor from the
 * newest event: a checkpoint captured before then is one the reactor never reads, so it is not
 * pending. Written once.
 */
export const markScanStart = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const since = DateTime.formatIso(yield* DateTime.now);
  yield* sql`INSERT INTO security_scan_since (id, since) VALUES (1, ${since})
    ON CONFLICT (id) DO NOTHING`;
});

/**
 * Builds the security sweep. It first retries the scan's failed events with `retryFailed`, the
 * reactor's own retry, which otherwise runs only at start. It records a `security` correction in
 * the learning plugin for each finding without one, which the reactor cannot: a reactor sees only
 * its own plugin's services, and a sweep runs with every active plugin's. The description names the
 * pattern, file and line, never the matched text, and the source key is the finding's id, so a
 * retry finds the same correction; a `scan_failed` row records none. It then reconciles each held
 * thread's `security_hold` flag with its open findings, and clears flags whose hold is gone. A dry
 * run counts what it would do and writes nothing.
 */
export const sweep = <E>(retryFailed: Effect.Effect<void, E, SqlClient.SqlClient>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const attention = yield* Attention.Attention;

    const run = Effect.fn("SecurityScanReactor.sweep")(function* (input: {
      readonly dryRun: boolean;
    }) {
      if (!input.dryRun) {
        yield* retryFailed.pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.catch((cause) =>
            Effect.logWarning("review: could not retry failed security scans", { cause }),
          ),
        );
      }
      const pending = yield* sql<FindingRow>`SELECT * FROM security_finding
      WHERE correction_id IS NULL AND pattern_id <> 'scan_failed'
      ORDER BY id LIMIT ${BATCH_SIZE}`;
      // Learning runs whenever this plugin does; without it there is nowhere to record.
      const corrections = Option.getOrUndefined(
        yield* Effect.serviceOption(CorrectionStore.CorrectionStore),
      );
      let acted = 0;
      for (const row of pending) {
        if (corrections === undefined) break;
        if (input.dryRun) {
          acted += 1;
          continue;
        }
        const correction = yield* corrections
          .record({
            threadId: row.thread_id,
            failureKind: "security",
            description: `${row.pattern_id} at ${row.file}:${row.line}`,
            sourceEventIds: [],
            sourceKey: sourceKeyOf(row),
            occurredAt: DateTime.makeUnsafe(row.created_at),
          })
          .pipe(
            Effect.catchTags({
              LearningError: (cause) =>
                Effect.logWarning("review: could not record a security correction", {
                  findingId: row.id,
                  cause,
                }).pipe(Effect.as(undefined)),
            }),
          );
        if (correction === undefined) continue;
        yield* sql`UPDATE security_finding SET correction_id = ${correction.id}
        WHERE id = ${row.id}`;
        acted += 1;
      }

      const held = yield* sql<{ readonly thread_id: ThreadId; readonly open: number }>`
      SELECT thread_id, COUNT(*) AS open FROM security_finding
      WHERE acknowledged_at IS NULL
      GROUP BY thread_id HAVING MAX(blocking) = 1`;
      const wanted = new Map<string, string>(
        held.map((row) => [row.thread_id, holdText(row.open)]),
      );
      const raised = new Map(
        (yield* attention.listOpen({ pluginId: "review", kind: "security_hold" })).map((flag) => [
          flag.threadId,
          flag.text,
        ]),
      );
      for (const threadId of new Set([...wanted.keys(), ...raised.keys()])) {
        const text = wanted.get(threadId);
        if (text === raised.get(threadId)) continue;
        acted += 1;
        if (input.dryRun) continue;
        yield* text === undefined
          ? attention.clear(flagKey(threadId))
          : attention.raise({ ...flagKey(threadId), text, resumeAction: RESUME_ACTION });
      }

      return { examined: pending.length + held.length, acted, flags: wanted.size };
    });

    return { plugin: "review", name: "security", run };
  });

/**
 * Starts the scan from the newest event, so turns before the plugin first ran are not scanned, and
 * registers its sweep with the reactor's retry; called from the plugin's layer.
 */
export const start = Effect.gen(function* () {
  const reactor = yield* PluginReactor.start({
    plugin: "review",
    from: "now",
    handlers: yield* handlers,
    onCursorCreated: markScanStart,
  });
  const supervisor = yield* PluginSupervisor.PluginSupervisor;
  yield* supervisor.register(yield* sweep(reactor.retryFailed()));
});
