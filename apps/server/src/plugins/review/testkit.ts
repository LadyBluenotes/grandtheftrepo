import {
  CheckpointId,
  OrchestrationV2Checkpoint,
  ProjectId,
  ThreadId,
  type ReviewVerdictInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { idleThreadProjection, liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as PluginDatabase from "../PluginDatabase.ts";
import * as CorrectionStore from "../learning/CorrectionStore.ts";
import { migrations as learningMigrations } from "../learning/migrations.ts";
import { migrations } from "./migrations.ts";
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
const checkpoint = (id: CheckpointId, threadId: ThreadId, status: "ready" | "stale") =>
  decodeCheckpoint({
    id,
    threadId,
    scopeId: `scope:${threadId}`,
    runId: null,
    nodeId: `node:${threadId}`,
    parentCheckpointId: null,
    ordinalWithinScope: 0,
    appRunOrdinal: null,
    ref: `ref:${id}`,
    status,
    files: [],
    capturedAt: DateTime.makeUnsafe("2026-10-01T00:00:00.000Z"),
  });

const checkpointsOf: Record<string, ReadonlyArray<OrchestrationV2Checkpoint>> = {
  [reviewed]: [checkpoint(ready, reviewed, "ready"), checkpoint(stale, reviewed, "stale")],
  [other]: [checkpoint(foreign, other, "ready")],
};

/** The read model: every thread is live except `nobody`; `reviewed` and `other` have checkpoints. */
export const layerThreads = Layer.mock(ThreadManagementService.ThreadManagementService)({
  getThreadShell: (id) => Effect.succeed(id === nobody ? null : liveThreadShell(id)),
  getThreadRecords: (id) =>
    Effect.succeed({
      ...idleThreadProjection(liveThreadShell(id)),
      checkpoints: checkpointsOf[id] ?? [],
    }),
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

/** Both plugins' databases, migrated, with the learning plugin having seen the threads. */
export const harness = Effect.gen(function* () {
  const review = yield* PluginDatabase.open({ id: "review", filename: ":memory:", migrations });
  const learning = yield* PluginDatabase.open({
    id: "learning",
    filename: ":memory:",
    migrations: learningMigrations,
  });
  // As `thread.created` leaves them.
  yield* learning.sql`INSERT INTO threads (thread_id, project_id)
    VALUES (${reviewed}, ${projectId}), (${other}, ${projectId})`;
  const corrections = yield* CorrectionStore.CorrectionStore.pipe(
    Effect.provide(
      CorrectionStore.layer.pipe(Layer.provide(Layer.succeed(SqlClient.SqlClient, learning.sql))),
    ),
  );
  const store = yield* VerdictStore.VerdictStore.pipe(
    Effect.provide(
      VerdictStore.layer.pipe(
        Layer.provide(Layer.succeed(SqlClient.SqlClient, review.sql)),
        Layer.provide(layerThreads),
      ),
    ),
  );
  const count = (sql: SqlClient.SqlClient, table: string) =>
    Effect.map(sql<{ n: number }>`SELECT COUNT(*) AS n FROM ${sql(table)}`, (rows) => rows[0]?.n);
  return {
    review: review.sql,
    store,
    corrections,
    verdictCount: count(review.sql, "review_verdicts"),
    correctionCount: count(learning.sql, "corrections"),
    record: (by: ThreadId, input: ReviewVerdictInput) =>
      store
        .record(by, input)
        .pipe(Effect.provideService(CorrectionStore.CorrectionStore, corrections)),
    list: store.list,
  };
});
