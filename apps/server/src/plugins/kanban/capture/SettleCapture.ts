import {
  CommandId,
  KanbanAlternative,
  KanbanAlternativeDisposition,
  KanbanAlternativeReasonKind,
  KanbanError,
  KanbanFindingScope,
  KanbanFindingTruth,
  KanbanSlug,
  ThreadId,
  TrimmedNonEmptyString,
  type OrchestrationV2Run,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PluginServices from "../../PluginServices.ts";
import * as TierSelectionService from "../../routing/TierSelectionService.ts";
import * as FindingService from "../findings/FindingService.ts";
import * as KanbanStore from "../KanbanStore.ts";
import { ENDED, finalMessage } from "../spec/SpecService.ts";
import * as StopGate from "../StopGate.ts";

const DecisionDraft = Schema.Struct({
  category: Schema.optional(Schema.String),
  title: TrimmedNonEmptyString,
  why: TrimmedNonEmptyString,
  alternatives: Schema.optional(Schema.Array(KanbanAlternative)),
});
const FindingDraft = Schema.Struct({
  title: TrimmedNonEmptyString,
  evidence: TrimmedNonEmptyString,
  truthStatus: Schema.optional(KanbanFindingTruth),
  scopeRelation: Schema.optional(KanbanFindingScope),
});
const decodeReply = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      decisions: Schema.optional(Schema.Array(Schema.Unknown)),
      findings: Schema.optional(Schema.Array(Schema.Unknown)),
    }),
  ),
);
const decodeDecision = Schema.decodeUnknownOption(DecisionDraft);
const decodeFinding = Schema.decodeUnknownOption(FindingDraft);
const isSlug = Schema.is(KanbanSlug);

/**
 * The drafts in the extraction turn's answer: the JSON object in it, wherever the model put it, and
 * of its entries only those that decode. Anything else is no drafts at all.
 */
export const parseDrafts = (text: string) => {
  const reply = decodeReply(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  const entries = Option.getOrUndefined(reply);
  return {
    decisions: (entries?.decisions ?? []).flatMap((entry) => Option.toArray(decodeDecision(entry))),
    findings: (entries?.findings ?? []).flatMap((entry) => Option.toArray(decodeFinding(entry))),
  };
};

/** A title as a repeat is recognized: its words, lowercased, accents dropped. */
const titleKey = (title: string) =>
  (
    title
      .normalize("NFKD")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).join(" ");

/** What the settled thread already recorded, and the decision categories the project has. */
interface Recorded {
  readonly decisions: ReadonlyArray<string>;
  readonly findings: ReadonlyArray<string>;
  readonly categories: ReadonlyArray<string>;
  /** The issues linking the thread, which its drafted decisions concern. */
  readonly issues: ReadonlyArray<string>;
}

const extractionPrompt = (title: string, reply: string, recorded: Recorded) =>
  [
    `Below is the last reply an agent gave in the thread "${title}". List each decision it says it made, where it chose one approach over another, and each problem it says it found outside its task, unless it is already recorded below. Answer from the reply alone: use no tools and change nothing.`,
    "",
    ...(recorded.decisions.length + recorded.findings.length === 0
      ? ["Nothing is recorded from this thread yet."]
      : [
          "Already recorded from this thread, so leave these out:",
          ...recorded.decisions.map((t) => `- Decision: ${t}`),
          ...recorded.findings.map((t) => `- Finding: ${t}`),
        ]),
    "",
    "Answer with one JSON object and nothing else, with an empty list where there is nothing:",
    '{"decisions":[{"category":"...","title":"...","why":"...","alternatives":[{"title":"...","disposition":"chosen","reason":"...","reasonKind":"contextual"}]}],"findings":[{"title":"...","evidence":"...","truthStatus":"seen","scopeRelation":"unrelated"}]}',
    "",
    `category is ${
      recorded.categories.length === 0
        ? "a short topic"
        : `one of ${recorded.categories.join(", ")}, or a new short topic`
    } in lowercase words joined by hyphens. List the option chosen and each one passed over as alternatives. disposition is one of ${KanbanAlternativeDisposition.literals.join(", ")}; reasonKind one of ${KanbanAlternativeReasonKind.literals.join(", ")}; truthStatus one of ${KanbanFindingTruth.literals.join(", ")}; scopeRelation one of ${KanbanFindingScope.literals.join(", ")}.`,
    "",
    "The reply:",
    "",
    reply,
  ].join("\n");

const NO_CHEAP_TIER =
  "The cheap tier is not configured; settle-time capture needs the routing plugin.";

interface CaptureRow {
  readonly child_thread_id: ThreadId;
  readonly project_id: ProjectId;
  readonly thread_id: ThreadId;
}

/**
 * Settle-time capture: once a thread settles in a project that turned it on, one turn on routing's
 * cheap tier reads the thread's last reply, and the decisions and findings it names that the thread
 * did not record are filed as drafts, a `proposed` decision or an `open` finding linked to the
 * thread, for a person to accept. Nothing here accepts anything.
 *
 * One settlement, a thread and its `settledAt`, gets one capture: the orchestrator emits
 * `thread.settled` again for a thread already settled, keeping its `settledAt`, and that starts
 * nothing, while a thread unsettled and settled again is read again. The extraction turn's thread
 * is named for the settlement, so a redelivered event resumes the same launch, and it is recorded
 * before the launch, so its run's end finds it. Kanban's own threads, these and spec drafting, are
 * never read: a capture thread settling starts nothing.
 *
 * Only the thread's current settlement is read, from the reply its latest run ended with. A settled
 * thread's run can still be going, as when a failed workspace preparation is retried after the
 * settle, so the settlement is also read when a run of the thread ends.
 */
export class SettleCapture extends Context.Service<
  SettleCapture,
  {
    /**
     * Starts the extraction turn for the thread's current settlement, once its latest run has
     * ended, on the cheap tier of the routing plugin, whose service the reactor's fiber reaches
     * only through `PluginServices`. Without a cheap tier, or while the emergency stop is set,
     * nothing starts, and that capture is not tried again.
     */
    readonly settled: (threadId: ThreadId) => Effect.Effect<void, KanbanError>;
    /**
     * Files the drafts of the capture whose thread `run` belongs to, once that run has completed,
     * then settles that thread. Drafts already recorded in the thread by then are left out, so a
     * retry after a failed write files only what is still missing. Any other thread's run that
     * ends is a `settled` for that thread.
     */
    readonly finish: (run: OrchestrationV2Run) => Effect.Effect<void, KanbanError>;
  }
>()("t3/plugins/kanban/capture/SettleCapture") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* KanbanStore.KanbanStore;
  const findings = yield* FindingService.FindingService;
  const gate = yield* StopGate.StopGate;
  const threads = yield* ThreadManagementService.ThreadManagementService;

  const io = (cause: SqlError.SqlError) =>
    Effect.logWarning("kanban: settle capture database operation failed", { cause }).pipe(
      Effect.andThen(
        Effect.fail(
          new KanbanError({
            code: "io",
            message: "The kanban database could not be read or written.",
          }),
        ),
      ),
    );
  const unreadable = (threadId: ThreadId) => (cause: unknown) =>
    Effect.logWarning("kanban: could not read a thread for settle capture", { cause }).pipe(
      Effect.andThen(
        Effect.fail(
          new KanbanError({ code: "io", message: `Could not read the thread "${threadId}".` }),
        ),
      ),
    );

  /** A thread kanban started itself, for a capture or a spec draft. */
  const isOwn = (threadId: ThreadId) =>
    sql<{ readonly found: number }>`
      SELECT 1 AS found FROM settle_capture WHERE child_thread_id = ${threadId}
      UNION ALL SELECT 1 FROM spec_attempt WHERE child_thread_id = ${threadId}
      LIMIT 1`.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.catchTags({ SqlError: io }),
    );

  /** The last thing the agent said in the thread's latest run, once that run has ended. */
  const lastReply = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const latest = ThreadManagementService.latestRun(
        yield* threads.getThreadRecords(threadId, ["runs"]),
      );
      if (latest === undefined || !ThreadManagementService.isTerminalRunStatus(latest.status))
        return undefined;
      const { turnItems } = yield* threads.getThreadRecords(threadId, ["turnItems"], {
        turnItemRunId: latest.id,
        turnItemTypes: ["assistant_message", "proposed_plan"],
      });
      return finalMessage(turnItems);
    }).pipe(Effect.catch(unreadable(threadId)));

  const recordedIn = (projectId: ProjectId, threadId: ThreadId) =>
    Effect.gen(function* () {
      const decisions = yield* store.listDecisions({ projectId });
      const issues = yield* store.transact(projectId, (current) =>
        Effect.succeed({ result: [...current.values()], save: [] }),
      );
      return {
        decisions: decisions.filter((d) => d.threads.includes(threadId)).map((d) => d.title),
        findings: issues.flatMap((issue) =>
          issue.findings.filter((f) => f.threadId === threadId).map((f) => f.title),
        ),
        categories: [...new Set(decisions.map((d) => d.category))],
        issues: issues
          .filter((issue) => issue.threads.some((link) => link.id === threadId))
          .map((issue) => issue.id),
      } satisfies Recorded;
    });

  /**
   * Run through `PluginServices`: the reactor's fiber holds neither the launcher nor the routing
   * plugin's tier service.
   */
  const launch = (input: {
    readonly projectId: ProjectId;
    readonly childThreadId: ThreadId;
    readonly title: string;
    readonly prompt: string;
  }) =>
    Effect.gen(function* () {
      yield* gate.assertLaunchAllowed;
      const launches = yield* Effect.serviceOption(ThreadLaunchService.ThreadLaunchService).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new KanbanError({ code: "io", message: "Threads cannot be started from here." }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );
      // `mechanical` work with no earlier runs is routing's cheap tier.
      yield* TierSelectionService.launch(
        { projectId: input.projectId, taskClass: "mechanical", earlierThreadIds: [] },
        (modelSelection) =>
          Effect.gen(function* () {
            if (modelSelection === undefined)
              return yield* new KanbanError({ code: "invalid", message: NO_CHEAP_TIER });
            return yield* launches.launch({
              commandId: CommandId.make(input.childThreadId),
              threadId: input.childThreadId,
              projectId: input.projectId,
              title: `Capture: ${input.title}`,
              modelSelection,
              // As strict as spec drafting: the turn only reads what it is given.
              runtimeMode: "approval-required",
              interactionMode: "plan",
              workspaceStrategy: { type: "root" },
              initialMessage: { text: input.prompt, attachments: [] },
              createdBy: "system",
              creationSource: "server",
            });
          }),
      );
    }).pipe(PluginServices.provide);

  const settled: SettleCapture["Service"]["settled"] = Effect.fn("SettleCapture.settled")(
    function* (threadId) {
      const { thread } = yield* threads
        .getThreadRecords(threadId, [])
        .pipe(Effect.catch(unreadable(threadId)));
      if (thread.settledAt === null) return;
      const settledAt = DateTime.formatIso(thread.settledAt);
      if (!(yield* store.captures(thread.projectId))) return;
      if (yield* isOwn(thread.id)) return;
      const reply = yield* lastReply(thread.id);
      if (reply === undefined) return;
      const recorded = yield* recordedIn(thread.projectId, thread.id);
      const childThreadId = ThreadId.make(`kanban-capture:${thread.id}:${settledAt}`);
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const inserted = yield* sql<{ readonly child_thread_id: ThreadId }>`
        INSERT INTO settle_capture
          (child_thread_id, project_id, thread_id, settled_at, status, created_at)
        VALUES
          (${childThreadId}, ${thread.projectId}, ${thread.id}, ${settledAt}, 'running', ${createdAt})
        ON CONFLICT DO NOTHING
        RETURNING child_thread_id
      `.pipe(Effect.catchTags({ SqlError: io }));
      // This settlement was captured, or tried, already.
      if (inserted.length === 0) return;
      yield* launch({
        projectId: thread.projectId,
        childThreadId,
        title: thread.title,
        prompt: extractionPrompt(thread.title, reply, recorded),
      }).pipe(
        // The settle stands either way; a capture that cannot start is not retried.
        Effect.catch((cause) =>
          Effect.logWarning("kanban: settle capture did not start", {
            threadId: thread.id,
            cause,
          }).pipe(
            Effect.andThen(
              sql`UPDATE settle_capture SET status = 'failed'
                WHERE child_thread_id = ${childThreadId}`.pipe(Effect.catchTags({ SqlError: io })),
            ),
          ),
        ),
      );
    },
  );

  const finish: SettleCapture["Service"]["finish"] = Effect.fn("SettleCapture.finish")(
    function* (run) {
      if (!ENDED.has(run.status)) return;
      const rows = yield* sql<CaptureRow>`UPDATE settle_capture
          SET status = ${run.status === "completed" ? "done" : "failed"}
          WHERE child_thread_id = ${run.threadId} AND status = 'running'
          RETURNING child_thread_id, project_id, thread_id`.pipe(
        Effect.catchTags({ SqlError: io }),
      );
      const capture = rows[0];
      if (capture === undefined) return yield* settled(run.threadId);
      if (run.status !== "completed") return;
      const { turnItems } = yield* threads
        .getThreadRecords(run.threadId, ["turnItems"], {
          turnItemRunId: run.id,
          turnItemTypes: ["assistant_message", "proposed_plan"],
        })
        .pipe(Effect.catch(unreadable(run.threadId)));
      const drafts = parseDrafts(finalMessage(turnItems) ?? "");
      // Read again: the thread or a person may have recorded one since the turn started. The
      // reactor runs this in the transaction that marked the capture done, so a write that fails
      // rolls it back to running and the event is retried, without the drafts that landed.
      const recorded = yield* recordedIn(capture.project_id, capture.thread_id);
      // The capture thread proposes the findings; a decision is filed by `system`, so its threads
      // stay the ones it was made in.
      const by = `thread:${capture.child_thread_id}`;
      const seenDecisions = new Set(recorded.decisions.map(titleKey));
      for (const draft of drafts.decisions) {
        const key = titleKey(draft.title);
        if (seenDecisions.has(key)) continue;
        seenDecisions.add(key);
        yield* store.write(capture.project_id, "system", {
          action: "decision.create",
          category:
            draft.category !== undefined && isSlug(draft.category) ? draft.category : "general",
          title: draft.title,
          why: draft.why,
          alternatives: draft.alternatives ?? [],
          state: "proposed",
          threads: [capture.thread_id],
          issues: recorded.issues,
        });
      }
      const seenFindings = new Set(recorded.findings.map(titleKey));
      for (const draft of drafts.findings) {
        const key = titleKey(draft.title);
        if (seenFindings.has(key)) continue;
        seenFindings.add(key);
        // On a Triage card of its own, as an agent's finding without an issue is.
        yield* findings.file(
          {
            projectId: capture.project_id,
            threadId: capture.thread_id,
            title: draft.title,
            evidence: draft.evidence,
            truthStatus: draft.truthStatus ?? "seen",
            scopeRelation: draft.scopeRelation ?? "unknown",
          },
          by,
        );
      }
      // Off the active list: its drafts are on the board, and the thread stays readable.
      yield* threads
        .settleThread({
          threadId: capture.child_thread_id,
          commandId: CommandId.make(`settle:${capture.child_thread_id}`),
          byOwnAgent: false,
        })
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("kanban: could not settle a capture thread", { cause }),
          ),
        );
    },
  );

  return SettleCapture.of({ settled, finish });
});

/** Over the plugin's `SqlClient`, which the host binds to `plugins/kanban.sqlite`. */
export const layer = Layer.effect(SettleCapture, make);
