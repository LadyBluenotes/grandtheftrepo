import type {
  CheckpointId,
  OrchestrationV2Checkpoint,
  OrchestrationV2Run,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import * as Stream from "effect/Stream";

import * as CheckpointDiffQuery from "../../../checkpointing/CheckpointDiffQuery.ts";
import type { CheckpointServiceError } from "../../../checkpointing/Errors.ts";
import * as EventSink from "../../../orchestration-v2/EventSink.ts";
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

/** Stores a checkpoint's matches; one per checkpoint, pattern, file and line, so a repeat adds none. */
const insertFindings = (
  sql: SqlClient.SqlClient,
  input: {
    readonly threadId: ThreadId;
    readonly checkpointId: CheckpointId;
    readonly matches: ReadonlyArray<Match>;
    readonly blocking: boolean;
    readonly createdAt: string;
  },
) =>
  sql`INSERT INTO security_finding ${sql.insert(
    input.matches.map((match) => ({
      thread_id: input.threadId,
      checkpoint_id: input.checkpointId,
      pattern_id: match.patternId,
      file: match.file,
      line: match.line,
      blocking: input.blocking ? 1 : 0,
      created_at: input.createdAt,
    })),
  )} ON CONFLICT (checkpoint_id, pattern_id, file, line) DO NOTHING`;

/**
 * Marks a checkpoint handled, with its findings, whatever the scan found or skipped, so `block` can
 * tell a scan still to come from one that found nothing.
 */
const markScanned = (sql: SqlClient.SqlClient, threadId: ThreadId, checkpointId: CheckpointId) =>
  Effect.gen(function* () {
    const scannedAt = DateTime.formatIso(yield* DateTime.now);
    yield* sql`INSERT INTO security_scan (checkpoint_id, thread_id, scanned_at)
      VALUES (${checkpointId}, ${threadId}, ${scannedAt})
      ON CONFLICT (checkpoint_id) DO NOTHING`;
  });

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
   * The matches on the lines the turn added, none when the checkpoint is not a root run's, or the
   * warning to log when the turn cannot be read: its run stopped or failed, and `getTurnDiff`
   * covers completed runs only, or there is no diff query to ask.
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
      if (run !== undefined && UNREADABLE_RUNS.has(run.status)) {
        return "review: security scan cannot read a turn that did not complete" as const;
      }
      // Read from the reactor fiber's context, which the server's chain gives it, rather than
      // required of the layer: that would put it in every plugin's requirements for this alone.
      const diffs = yield* Effect.serviceOption(CheckpointDiffQuery.CheckpointDiffQuery);
      if (Option.isNone(diffs)) {
        return "review: security scan skipped, no checkpoint diff query" as const;
      }
      return scan(yield* turnDiff(diffs.value, threadId, ordinal));
    });

  /**
   * Scans one ready checkpoint of `threadId` and stores what it found. A turn the scan cannot read
   * holds the thread in `block`; in `warn` a turn that stopped or failed, or one with no diff query
   * to ask, is passed over with a warning, a stopped or failed one's lines scanned with the next
   * completed turn's, and any other failure fails the event for the sweep to retry. The project's mode is read now, as the scan runs: the moment the turn ended,
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
              }).pipe(Effect.as(SCAN_FAILED))
            : Effect.fail(cause),
        ),
      );
      if (typeof scanned === "string") {
        yield* Effect.logWarning(scanned, { threadId, checkpointId: checkpoint.id });
        if (mode === "warn") return;
      }
      const matches = typeof scanned === "string" ? SCAN_FAILED : scanned;
      if (matches.length === 0) return;

      yield* insertFindings(sql, {
        threadId,
        checkpointId: checkpoint.id,
        matches,
        blocking: mode === "block",
        createdAt: DateTime.formatIso(occurredAt),
      });
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
        yield* markScanned(sql, threadId, checkpoint.id);
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
 * reactor's own retry, which otherwise runs only at start. An event the reactor gave up on, after
 * `PluginReactor.MAX_ATTEMPTS`, would leave its checkpoint without a scan row, pending in `block`
 * for good with nothing to acknowledge; the sweep settles it instead. In a project in `block` at
 * that point the checkpoint gets a `scan_failed` finding, in any other only its scan row, and the
 * failure row goes, so it is settled once. It records a `security` correction in
 * the learning plugin for each finding without one, which the reactor cannot: a reactor sees only
 * its own plugin's services, and a sweep runs with every active plugin's. The description names the
 * pattern, file and line, never the matched text, and the source key is built from the finding's
 * thread, checkpoint, pattern, file and line (`sourceKeyOf`), so a retry finds the same correction
 * and a rebuilt review database never lands on an old one; a `scan_failed` row records none. It then reconciles each held
 * thread's `security_hold` flag with its open findings, and clears flags whose hold is gone. A dry
 * run counts what it would do and writes nothing.
 */
export const sweep = <E>(retryFailed: Effect.Effect<void, E, SqlClient.SqlClient>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const attention = yield* Attention.Attention;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const sink = yield* EventSink.EventSinkV2;

    /** The committed event at `sequence`, or undefined once the log no longer holds it. */
    const readEvent = (sequence: number) =>
      Effect.gen(function* () {
        // Past the log the stream would wait for live events forever.
        if (sequence > (yield* sink.latestSequence())) return undefined;
        const events = yield* Stream.runCollect(
          sink.stream({ afterSequence: sequence - 1 }).pipe(Stream.take(1)),
        );
        return events.find((stored) => stored.sequence === sequence);
      });

    /**
     * Settles one event the reactor gave up on, in one transaction. Should it fail, as when the
     * thread cannot be read now, the failure row stays for the next tick.
     */
    const settle = (sequence: number) =>
      Effect.gen(function* () {
        const stored = yield* readEvent(sequence);
        const event = stored?.event;
        if (event?.type === "checkpoint.captured" && event.payload.status === "ready") {
          const shell = yield* threads.getThreadShell(event.threadId);
          if (shell !== null && shell.deletedAt === null) {
            if ((yield* modeOf(sql, shell.projectId)) === "block") {
              yield* insertFindings(sql, {
                threadId: event.threadId,
                checkpointId: event.payload.id,
                matches: SCAN_FAILED,
                blocking: true,
                createdAt: DateTime.formatIso(event.occurredAt),
              });
            }
          }
          yield* markScanned(sql, event.threadId, event.payload.id);
        }
        yield* sql`DELETE FROM host_reactor_failure WHERE sequence = ${sequence}`;
      }).pipe(sql.withTransaction);

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
      const exhausted = yield* sql<{ readonly sequence: number }>`
        SELECT sequence FROM host_reactor_failure
        WHERE attempts >= ${PluginReactor.MAX_ATTEMPTS} ORDER BY sequence`;
      let settled = 0;
      for (const { sequence } of exhausted) {
        if (input.dryRun) {
          settled += 1;
          continue;
        }
        const done = yield* settle(sequence).pipe(
          Effect.as(true),
          Effect.catch((cause) =>
            Effect.logWarning("review: could not settle a failed security scan", {
              sequence,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
        if (done) settled += 1;
      }
      const pending = yield* sql<FindingRow>`SELECT * FROM security_finding
      WHERE correction_id IS NULL AND pattern_id <> 'scan_failed'
      ORDER BY id LIMIT ${BATCH_SIZE}`;
      // Learning runs whenever this plugin does; without it there is nowhere to record.
      const corrections = Option.getOrUndefined(
        yield* Effect.serviceOption(CorrectionStore.CorrectionStore),
      );
      let acted = settled;
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
