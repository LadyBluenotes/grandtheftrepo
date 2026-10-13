import {
  CheckpointId,
  OrchestrationV2Checkpoint,
  OrchestrationV2CheckpointScope,
  type OrchestrationV2Run,
  ProjectId,
  ThreadId,
  type ReviewVerdictInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { idleThreadProjection, liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as Attention from "../Attention.ts";
import * as HostDatabase from "../HostDatabase.ts";
import * as PluginDatabase from "../PluginDatabase.ts";
import * as CorrectionStore from "../learning/CorrectionStore.ts";
import { migrations as learningMigrations } from "../learning/migrations.ts";
import { migrations } from "./migrations.ts";
import * as ReviewGate from "./ReviewGate.ts";
import * as ReviewInvalidationSweep from "./ReviewInvalidationSweep.ts";
import * as ReviewRequests from "./ReviewRequests.ts";
import * as SecurityHold from "./security/SecurityHold.ts";
import * as VerdictStore from "./VerdictStore.ts";

export const reviewed = ThreadId.make("thread:reviewed");
export const reviewer = ThreadId.make("thread:reviewer");
export const other = ThreadId.make("thread:other");
export const nobody = ThreadId.make("thread:nobody");
export const ready = CheckpointId.make("checkpoint:ready");
export const stale = CheckpointId.make("checkpoint:stale");
export const foreign = CheckpointId.make("checkpoint:of-other");
// The project every thread of `liveThreadShell` belongs to.
export const projectId = ProjectId.make("project:mcp-test");

const decodeCheckpoint = Schema.decodeUnknownSync(OrchestrationV2Checkpoint);
const decodeScope = Schema.decodeUnknownSync(OrchestrationV2CheckpointScope);
const DAY_ONE = DateTime.makeUnsafe("2026-10-01T00:00:00.000Z");

/** A checkpoint of `threadId`'s root scope, captured `day` days after the first. */
const checkpoint = (
  id: CheckpointId,
  threadId: ThreadId,
  status: "ready" | "stale",
  day = 0,
  scopeId = `scope:${threadId}`,
) =>
  decodeCheckpoint({
    id,
    threadId,
    scopeId,
    runId: null,
    nodeId: `node:${threadId}`,
    parentCheckpointId: null,
    ordinalWithinScope: day,
    appRunOrdinal: null,
    ref: `ref:${id}`,
    status,
    files: [],
    capturedAt: DateTime.add(DAY_ONE, { days: day }),
  });

const rootScope = (threadId: ThreadId) =>
  decodeScope({
    id: `scope:${threadId}`,
    threadId,
    runId: null,
    nodeId: `node:${threadId}`,
    parentScopeId: null,
    providerThreadId: null,
    kind: "root_run",
    ordinalWithinParent: 0,
    advancesAppRunCount: true,
    cwd: "/repo",
    createdAt: DAY_ONE,
  });

/** A later ready checkpoint of `reviewed`, which a test captures to move the thread on. */
export const later = CheckpointId.make("checkpoint:later");
/** A ready checkpoint outside the root scope, which never counts as the latest. */
const subagentWork = CheckpointId.make("checkpoint:subagent");

const initialCheckpoints: Readonly<Record<string, ReadonlyArray<OrchestrationV2Checkpoint>>> = {
  [reviewed]: [
    checkpoint(ready, reviewed, "ready"),
    checkpoint(stale, reviewed, "stale", 1),
    checkpoint(subagentWork, reviewed, "ready", 2, `scope:${reviewed}:subagent`),
  ],
  [other]: [checkpoint(foreign, other, "ready")],
};

/**
 * The read model: every thread is live except `nobody`; `reviewed` and `other` have checkpoints,
 * all in each thread's root scope but `subagentWork`. `captureLater` moves `reviewed` on to
 * `later`, a day after its last root checkpoint; `rollBackLater` rolls it back to `ready`, which
 * leaves `later` in its records marked stale.
 */
export const readModel = Effect.gen(function* () {
  const checkpoints = yield* Ref.make(initialCheckpoints);
  const runs = yield* Ref.make<Readonly<Record<string, ReadonlyArray<OrchestrationV2Run>>>>({});
  const setLater = (status: "ready" | "stale") =>
    Ref.update(checkpoints, (all) => ({
      ...all,
      [reviewed]: [
        ...(all[reviewed] ?? []).filter((record) => record.id !== later),
        checkpoint(later, reviewed, status, 3),
      ],
    }));
  return {
    layer: Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: (id) => Effect.succeed(id === nobody ? null : liveThreadShell(id)),
      getThreadRecords: (id) =>
        Effect.map(Effect.all([Ref.get(checkpoints), Ref.get(runs)]), ([all, allRuns]) => ({
          ...idleThreadProjection(liveThreadShell(id)),
          checkpointScopes: [rootScope(id)],
          checkpoints: all[id] ?? [],
          runs: allRuns[id] ?? [],
        })),
    }),
    captureLater: setLater("ready"),
    rollBackLater: setLater("stale"),
    /** Replaces the runs `threadId`'s records hold, which start empty. */
    setRuns: (threadId: ThreadId, list: ReadonlyArray<OrchestrationV2Run>) =>
      Ref.update(runs, (all) => ({ ...all, [threadId]: list })),
  };
});

const base = {
  threadId: reviewed,
  checkpointId: ready,
  summary: "No test covers the new branch.",
} as const;
/** A changes-requested verdict on `reviewed`'s ready checkpoint. */
export const sendBack = {
  ...base,
  outcome: "changes_requested",
  failureMode: "missing_verification",
} as const satisfies ReviewVerdictInput;
export const withoutMode = {
  ...base,
  outcome: "changes_requested",
} as const satisfies ReviewVerdictInput;
export const approve = {
  ...base,
  outcome: "approve",
  summary: "Looks right.",
} as const satisfies ReviewVerdictInput;

/**
 * Both plugins' databases and the host's, migrated, with the learning plugin having seen the
 * threads, and every review service over them.
 */
export const harness = Effect.gen(function* () {
  const review = yield* PluginDatabase.open({ id: "review", filename: ":memory:", migrations });
  const learning = yield* PluginDatabase.open({
    id: "learning",
    filename: ":memory:",
    migrations: learningMigrations,
  });
  const host = yield* PluginDatabase.open({
    id: "_host",
    filename: ":memory:",
    migrations: HostDatabase.migrations,
  });
  // As `thread.created` leaves them.
  yield* learning.sql`INSERT INTO threads (thread_id, project_id)
    VALUES (${reviewed}, ${projectId}), (${other}, ${projectId})`;
  const corrections = yield* CorrectionStore.CorrectionStore.pipe(
    Effect.provide(
      CorrectionStore.layer.pipe(Layer.provide(Layer.succeed(SqlClient.SqlClient, learning.sql))),
    ),
  );
  const threads = yield* readModel;
  const layerDeps = Layer.mergeAll(
    Layer.succeed(SqlClient.SqlClient, review.sql),
    threads.layer,
    Attention.layer.pipe(Layer.provide(Layer.succeed(HostDatabase.HostDatabase, host.sql))),
  );
  const { store, requests, gate, sweep, security, attention } = yield* Effect.all({
    store: VerdictStore.VerdictStore,
    requests: ReviewRequests.ReviewRequests,
    gate: ReviewGate.ReviewGate,
    sweep: ReviewInvalidationSweep.sweep,
    security: SecurityHold.SecurityHold,
    attention: Attention.Attention,
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        VerdictStore.layer,
        ReviewRequests.layer,
        ReviewGate.layer,
        SecurityHold.layer,
      ).pipe(Layer.provideMerge(layerDeps)),
    ),
  );
  const count = (sql: SqlClient.SqlClient, table: string) =>
    Effect.map(sql<{ n: number }>`SELECT COUNT(*) AS n FROM ${sql(table)}`, (rows) => rows[0]?.n);
  return {
    review: review.sql,
    host: host.sql,
    layerThreads: threads.layer,
    store,
    requests,
    gate,
    security,
    attention,
    corrections,
    sweep: sweep.run,
    verdictCount: count(review.sql, "review_verdicts"),
    correctionCount: count(learning.sql, "corrections"),
    record: (by: ThreadId, input: ReviewVerdictInput) =>
      store
        .record(by, input)
        .pipe(Effect.provideService(CorrectionStore.CorrectionStore, corrections)),
    list: store.list,
    captureLater: threads.captureLater,
    rollBackLater: threads.rollBackLater,
    setRuns: threads.setRuns,
    /** Rows the review and host connections have inserted, updated or deleted since they opened. */
    changes: Effect.map(
      Effect.forEach(
        [review.sql, host.sql],
        (sql) => sql<{ n: number }>`SELECT total_changes() AS n`,
      ),
      (counts) => counts.reduce((sum, [row]) => sum + (row?.n ?? 0), 0),
    ),
  };
});
