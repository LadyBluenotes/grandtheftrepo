import type { OrchestrationV2AppThread, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * What the producers know about a thread, from the thread events the reactor
 * replays: its project, whether it is settled, and which of its pull requests
 * ask for changes. Nothing here reads the core database.
 */
export interface ThreadFacts {
  readonly project_id: ProjectId;
  readonly settled: number;
  /** A JSON array of pull request keys. */
  readonly changes_requested: string;
}

/** Every thread event carries the whole thread, so any of them can introduce it. */
export const rememberThread = (thread: Pick<OrchestrationV2AppThread, "id" | "projectId">) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) =>
      sql`INSERT INTO threads (thread_id, project_id) VALUES (${thread.id}, ${thread.projectId})
          ON CONFLICT (thread_id) DO UPDATE SET project_id = excluded.project_id`,
  ).pipe(Effect.asVoid);

export const threadFacts = (threadId: ThreadId) =>
  Effect.map(
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) =>
        sql<ThreadFacts>`SELECT project_id, settled, changes_requested FROM threads
          WHERE thread_id = ${threadId}`,
    ),
    (rows) => rows[0],
  );
