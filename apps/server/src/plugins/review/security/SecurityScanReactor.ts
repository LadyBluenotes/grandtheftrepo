import type { ThreadId } from "@t3tools/contracts";
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
import { scan } from "./patterns.ts";
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
 * Scans each root-run checkpoint's turn: the lines its diff adds, against the fixed patterns, unless
 * the project's mode is `off`. A match is stored once per checkpoint, pattern, file and line, so a
 * replayed event adds nothing. In `block` the thread's hold is open and its flag raised here; the
 * sweep raises it again should that write fail.
 */
export const handlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const diffs = yield* CheckpointDiffQuery.CheckpointDiffQuery;
  const attention = yield* Attention.Attention;

  /**
   * The diff of the turn ending at `ordinal`, from the turn before it. A stopped turn has no
   * checkpoint to diff from, so the diff starts at the last one before it that has; empty when this
   * turn has none to diff to, as when it was stopped itself or rolled back since.
   */
  const turnDiff = Effect.fn("SecurityScanReactor.turnDiff")(function* (
    threadId: ThreadId,
    ordinal: number,
  ) {
    for (let from = ordinal - 1; from >= 0; from--) {
      const diff = yield* diffs
        .getTurnDiff({ threadId, fromTurnCount: from, toTurnCount: ordinal })
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

  const result: PluginReactor.Handlers<
    SqlError.SqlError | Orchestrator.OrchestratorV2Error | CheckpointServiceError
  > = {
    "checkpoint.captured": ({ event }) =>
      Effect.gen(function* () {
        const { threadId, payload: checkpoint } = event;
        const ordinal = checkpoint.appRunOrdinal;
        if (checkpoint.status !== "ready" || ordinal === null || checkpoint.threadId !== threadId) {
          return;
        }
        const shell = yield* threads.getThreadShell(threadId);
        if (shell === null || shell.deletedAt !== null) return;
        const mode = yield* modeOf(sql, shell.projectId);
        if (mode === "off") return;
        const { checkpointScopes } = yield* threads.getThreadRecords(threadId, [
          "checkpointScopes",
        ]);
        const root = checkpointScopes.some(
          (scope) => scope.id === checkpoint.scopeId && scope.kind === "root_run",
        );
        if (!root) return;
        const matches = scan(yield* turnDiff(threadId, ordinal));
        if (matches.length === 0) return;

        const createdAt = DateTime.formatIso(event.occurredAt);
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
      }),
  };
  return result;
});

/**
 * Builds the security sweep. It records a `security` correction in the learning plugin for each
 * finding without one, which the reactor cannot: a reactor sees only its own plugin's services,
 * and a sweep runs with every active plugin's. The description names the pattern, file and line,
 * never the matched text, and the source key is the finding's id, so a retry finds the same
 * correction. It then reconciles each held thread's `security_hold` flag with its open findings,
 * and clears flags whose hold is gone. A dry run counts what it would do and writes nothing.
 */
export const sweep = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const attention = yield* Attention.Attention;

  const run = Effect.fn("SecurityScanReactor.sweep")(function* (input: {
    readonly dryRun: boolean;
  }) {
    const pending = yield* sql<FindingRow>`SELECT * FROM security_finding
      WHERE correction_id IS NULL ORDER BY id LIMIT ${BATCH_SIZE}`;
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
          sourceKey: `security:${row.id}`,
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
    const wanted = new Map<string, string>(held.map((row) => [row.thread_id, holdText(row.open)]));
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
 * registers its sweep; called from the plugin's layer.
 */
export const start = Effect.gen(function* () {
  yield* PluginReactor.start({ plugin: "review", from: "now", handlers: yield* handlers });
  const supervisor = yield* PluginSupervisor.PluginSupervisor;
  yield* supervisor.register(yield* sweep);
});
