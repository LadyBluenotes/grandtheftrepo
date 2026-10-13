import {
  CommandId,
  KanbanError,
  ThreadId,
  type KanbanGetIssueInput,
  type KanbanIssue,
  type KanbanSpecAttempt,
  type KanbanSpecifyInput,
  type KanbanSpecReport,
  type KanbanSpecSource,
  type KanbanSpecStatus,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as TierSelectionService from "../../routing/TierSelectionService.ts";
import * as KanbanStore from "../KanbanStore.ts";
import * as StopGate from "../StopGate.ts";
import { SPEC_FORMAT, validateSpec } from "./SpecValidator.ts";

const NO_CHEAP_TIER =
  "The cheap tier is not configured. Use useExisting or enable the routing plugin.";

/** Why an attempt is closed when `admit` finds a different issue than the one it checked. */
const ISSUE_CHANGED = "The issue changed while the spec was drafted. Run specify again.";
/** Why one is closed when the issue is gone: there is nothing to run specify on again. */
const ISSUE_DELETED = "The issue was deleted while the spec was drafted.";

/** Why a restart closes an attempt: its thread or first run was never created, so no run can end it. */
const NEVER_STARTED = "The drafting thread was never started. Run specify again.";

/** The run statuses that end a drafting thread's attempt. `waiting` still has a person to answer. */
const ENDED = new Set<OrchestrationV2Run["status"]>([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
]);

/**
 * The modes the drafting thread runs with. Only a caller that has them checked against its own,
 * such as the MCP tool, passes them; the gateway does not, and gets the strictest pair.
 */
interface DraftingModes {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

const STRICTEST_MODES: DraftingModes = {
  runtimeMode: "approval-required",
  interactionMode: "plan",
};

/**
 * Turns a Triage or Inbox issue into a checkable spec, one attempt per call. `specify` validates
 * the description as written, or starts a drafting thread in plan mode on routing's cheap tier;
 * `finish`, called by the reactor when that thread's run ends, validates what it wrote. A valid
 * spec admits the issue with its Acceptance items as criteria; a malformed one only records why.
 *
 * Each attempt records the hash of the issue it started from, its creation time, title and
 * description, and the admission applies only while the issue still has them: an issue edited, or
 * deleted and recreated under the same id, while a child drafted closes the attempt as
 * `malformed` and stays where it is. So does an issue deleted outright: a missing issue is an
 * outcome of the attempt, not a failure to retry.
 *
 * The attempt is stored, with its outcome, before the issue is admitted: admitting renames the
 * issue file, which no SQL transaction can cover, and a card admitted without an attempt would
 * have nothing to show for it. A crash between the two leaves a `valid` attempt for a card still
 * in Triage or Inbox. A person recovers it by calling `specify` again: the "already admitted"
 * refusal only applies once the card has left those columns.
 *
 * A drafting thread that fails to launch closes its attempt as `malformed` instead of deleting it:
 * the launcher stores the thread and its first message before its later checks, so a failure can
 * come after the run has started. That run has no attempt to report into, since `finish` only
 * decides `running` attempts, and the person runs `specify` again.
 */
export class SpecService extends Context.Service<
  SpecService,
  {
    /**
     * Call from a request fiber: the drafting thread is launched with the thread launcher and the
     * routing plugin's tier service the caller's context holds.
     */
    readonly specify: (
      input: KanbanSpecifyInput & { readonly modes?: DraftingModes },
    ) => Effect.Effect<KanbanSpecAttempt, KanbanError>;
    /** The latest attempt with the status its issue is in now; null while there is no attempt. */
    readonly latest: (
      input: KanbanGetIssueInput,
    ) => Effect.Effect<KanbanSpecReport | null, KanbanError>;
    /** Decides the running attempt whose drafting thread `run` belongs to, once the run has ended. */
    readonly finish: (run: OrchestrationV2Run) => Effect.Effect<void, KanbanError>;
    /**
     * For when the plugin starts. An attempt is stored before its thread is created, and the
     * launcher creates the thread and then dispatches its first message, which creates the run. A
     * process that exited before the run exists left an attempt `running` that no run will ever
     * end: this closes each attempt stored before this call whose thread, or whose thread's first
     * run, does not exist as `malformed`. One whose run exists is left to the reactor, which
     * resumes from its saved cursor.
     */
    readonly reconcile: Effect.Effect<void, KanbanError>;
  }
>()("t3/plugins/kanban/spec/SpecService") {}

interface AttemptRow {
  readonly id: number;
  readonly project_id: ProjectId;
  readonly issue_id: string;
  readonly source: KanbanSpecSource;
  readonly source_hash: string;
  readonly child_thread_id: ThreadId | null;
  readonly status: KanbanSpecStatus;
  readonly text: string | null;
  readonly reason: string | null;
  readonly created_at: string;
  readonly completed_at: string | null;
}

const toAttempt = (row: AttemptRow): KanbanSpecAttempt => ({
  id: row.id,
  projectId: row.project_id,
  issueId: row.issue_id,
  source: row.source,
  childThreadId: row.child_thread_id,
  status: row.status,
  text: row.text,
  reason: row.reason,
  createdAt: row.created_at,
  completedAt: row.completed_at,
});

const invalid = (message: string) => new KanbanError({ code: "invalid", message });

/** What the drafting thread is asked: the issue as filed and the format to answer in. */
const draftingPrompt = (issue: KanbanIssue) =>
  [
    `Draft a spec for the kanban issue "${issue.title}" below. Read the code if it helps; change nothing.`,
    "",
    "Your proposed plan, or your final message, must be the spec alone, in exactly this format: these headings once each, in this order, and no others.",
    "",
    SPEC_FORMAT,
    "",
    "The issue as filed:",
    "",
    issue.description.length > 0 ? issue.description : "(no description)",
  ].join("\n");

/** Plan mode answers with a proposed plan; without one, the last thing the agent said counts. */
const finalMessage = (items: ReadonlyArray<OrchestrationV2TurnItem>) => {
  let plan: string | undefined;
  let message: string | undefined;
  // The projection returns items in ordinal order, so the last of each kind wins.
  for (const item of items) {
    if (item.type === "proposed_plan" && item.markdown.trim() !== "") plan = item.markdown;
    if (item.type === "assistant_message" && item.text.trim() !== "") message = item.text;
  }
  return plan ?? message;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* KanbanStore.KanbanStore;
  const gate = yield* StopGate.StopGate;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const crypto = yield* Crypto.Crypto;

  const io = (cause: SqlError.SqlError) =>
    Effect.logWarning("kanban: spec database operation failed", { cause }).pipe(
      Effect.andThen(
        Effect.fail(
          new KanbanError({
            code: "io",
            message: "The kanban database could not be read or written.",
          }),
        ),
      ),
    );
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const insert = (attempt: Omit<KanbanSpecAttempt, "id">, sourceHash: string) =>
    sql<{ readonly id: number }>`
      INSERT INTO spec_attempt
        (project_id, issue_id, source, source_hash, child_thread_id, status, text, reason,
         created_at, completed_at)
      VALUES
        (${attempt.projectId}, ${attempt.issueId}, ${attempt.source}, ${sourceHash},
         ${attempt.childThreadId}, ${attempt.status}, ${attempt.text}, ${attempt.reason},
         ${attempt.createdAt}, ${attempt.completedAt})
      RETURNING id
    `.pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.die("The spec attempt row vanished after it was written.")
          : Effect.succeed<KanbanSpecAttempt>({ ...attempt, id: rows[0].id }),
      ),
    );

  const close = (input: {
    readonly id: number;
    readonly status: "valid" | "malformed";
    readonly text: string | null;
    readonly reason: string | null;
  }) =>
    Effect.flatMap(
      nowIso,
      (completedAt) =>
        sql`UPDATE spec_attempt
          SET status = ${input.status}, text = ${input.text}, reason = ${input.reason},
            completed_at = ${completedAt}
          WHERE id = ${input.id}`,
    ).pipe(Effect.asVoid, Effect.catchTags({ SqlError: io }));

  /**
   * Admits the issue a valid spec was checked against. When it has changed or is gone, closes the
   * attempt as `malformed` and returns why; otherwise returns nothing. Any other failure
   * propagates: the reactor retries it.
   */
  const admit = (input: {
    readonly attemptId: number;
    readonly projectId: ProjectId;
    readonly issueId: string;
    readonly text: string | null;
    readonly acceptance: ReadonlyArray<string>;
    readonly sourceHash: string;
  }) =>
    store.admit(input.projectId, input.issueId, "spec", input.acceptance, input.sourceHash).pipe(
      Effect.catchTags({
        KanbanError: (error) =>
          error.code === "not_found" ? Effect.succeed("deleted" as const) : Effect.fail(error),
      }),
      Effect.flatMap((outcome) => {
        if (outcome !== "changed" && outcome !== "deleted") return Effect.void;
        const reason = outcome === "changed" ? ISSUE_CHANGED : ISSUE_DELETED;
        return close({
          id: input.attemptId,
          status: "malformed",
          text: input.text,
          reason,
        }).pipe(Effect.as(reason));
      }),
    );

  const existing = Effect.fn("SpecService.existing")(function* (
    issue: KanbanIssue,
    projectId: ProjectId,
  ) {
    const check = validateSpec(issue.description);
    const createdAt = yield* nowIso;
    const sourceHash = KanbanStore.hashSource(issue);
    // The attempt first, then the issue file; see the order note on `SpecService`.
    const attempt = yield* insert(
      {
        projectId,
        issueId: issue.id,
        source: "existing",
        childThreadId: null,
        status: check.valid ? "valid" : "malformed",
        text: issue.description,
        reason: check.valid ? null : check.reason,
        createdAt,
        completedAt: createdAt,
      },
      sourceHash,
    ).pipe(Effect.catchTags({ SqlError: io }));
    if (!check.valid) return attempt;
    const reason = yield* admit({
      attemptId: attempt.id,
      projectId,
      issueId: issue.id,
      text: attempt.text,
      acceptance: check.acceptance,
      sourceHash,
    });
    return reason === undefined
      ? attempt
      : ({ ...attempt, status: "malformed", reason } satisfies KanbanSpecAttempt);
  });

  const draft = Effect.fn("SpecService.draft")(function* (
    issue: KanbanIssue,
    projectId: ProjectId,
    modes: DraftingModes,
  ) {
    yield* gate.assertLaunchAllowed;
    // From the calling fiber, which always has one: naming it in the plugin's layer would add it
    // to what every host test must provide.
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
    const commandId = CommandId.make(
      `kanban-spec:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
    );
    const childThreadId = ThreadId.make(commandId);
    // `mechanical` work with no earlier runs is routing's cheap tier.
    const launched = yield* TierSelectionService.launch(
      { projectId, taskClass: "mechanical", earlierThreadIds: [] },
      (modelSelection) =>
        modelSelection === undefined
          ? Effect.fail(invalid(NO_CHEAP_TIER))
          : Effect.gen(function* () {
              // Stored before the launch, so the reactor finds it however soon the run ends.
              const attempt = yield* insert(
                {
                  projectId,
                  issueId: issue.id,
                  source: "child",
                  childThreadId,
                  status: "running",
                  text: null,
                  reason: null,
                  createdAt: yield* nowIso,
                  completedAt: null,
                },
                // The text the child is asked to spec; see `ISSUE_CHANGED`.
                KanbanStore.hashSource(issue),
              ).pipe(Effect.catchTags({ SqlError: io }));
              yield* launches
                .launch({
                  commandId,
                  threadId: childThreadId,
                  projectId,
                  title: `Spec: ${issue.title}`,
                  modelSelection,
                  runtimeMode: modes.runtimeMode,
                  interactionMode: modes.interactionMode,
                  workspaceStrategy: { type: "root" },
                  initialMessage: { text: draftingPrompt(issue), attachments: [] },
                  createdBy: "system",
                  creationSource: "server",
                })
                .pipe(
                  Effect.onError((cause) => {
                    const failure = Cause.squash(cause);
                    return close({
                      id: attempt.id,
                      status: "malformed",
                      text: null,
                      reason: `The drafting thread could not be started: ${
                        failure instanceof Error ? failure.message : "the launch did not finish."
                      }`,
                    }).pipe(Effect.ignore);
                  }),
                  Effect.catchTags({
                    ThreadLaunchError: (cause) =>
                      Effect.logWarning("kanban: drafting thread did not start", { cause }).pipe(
                        Effect.andThen(
                          Effect.fail(
                            new KanbanError({
                              code: "io",
                              message: "The drafting thread could not be started.",
                            }),
                          ),
                        ),
                      ),
                    ThreadManagementProviderInstanceDisabledError: (error) =>
                      Effect.fail(invalid(error.message)),
                  }),
                );
              return { threadId: childThreadId, attempt };
            }),
    ).pipe(
      Effect.catchTags({
        RoutingError: (error) =>
          Effect.fail(new KanbanError({ code: "io", message: error.message })),
      }),
    );
    return launched.attempt;
  });

  const specify: SpecService["Service"]["specify"] = Effect.fn("SpecService.specify")(function* ({
    projectId,
    id,
    useExisting,
    modes = STRICTEST_MODES,
  }) {
    const issue = yield* store.getIssue({ projectId, id });
    if (issue.status !== "triage" && issue.status !== "inbox")
      return yield* invalid("This ticket is already admitted.");
    return useExisting === true
      ? yield* existing(issue, projectId)
      : yield* draft(issue, projectId, modes);
  });

  const latest: SpecService["Service"]["latest"] = Effect.fn("SpecService.latest")(function* ({
    projectId,
    id,
  }) {
    const rows = yield* sql<AttemptRow>`SELECT * FROM spec_attempt
        WHERE project_id = ${projectId} AND issue_id = ${id}
        ORDER BY id DESC LIMIT 1`.pipe(Effect.catchTags({ SqlError: io }));
    if (rows[0] === undefined) return null;
    // A deleted issue still has its attempts, and the deletion may be why one was closed.
    const issueStatus = yield* store.getIssue({ projectId, id }).pipe(
      Effect.map((issue) => issue.status),
      Effect.catchTags({
        KanbanError: (error) =>
          error.code === "not_found" ? Effect.succeed(null) : Effect.fail(error),
      }),
    );
    return { attempt: toAttempt(rows[0]), issueStatus };
  });

  const finish: SpecService["Service"]["finish"] = Effect.fn("SpecService.finish")(function* (run) {
    if (!ENDED.has(run.status)) return;
    const rows = yield* sql<AttemptRow>`SELECT * FROM spec_attempt
        WHERE child_thread_id = ${run.threadId} AND status = 'running'`.pipe(
      Effect.catchTags({ SqlError: io }),
    );
    const attempt = rows[0];
    if (attempt === undefined) return;
    if (run.status !== "completed")
      return yield* close({
        id: attempt.id,
        status: "malformed",
        text: null,
        reason: `The drafting run ended ${run.status} before it sent a spec.`,
      });
    const { turnItems } = yield* threads
      .getThreadRecords(run.threadId, ["turnItems"], {
        turnItemRunId: run.id,
        turnItemTypes: ["assistant_message", "proposed_plan"],
      })
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("kanban: could not read the drafting thread", { cause }).pipe(
            Effect.andThen(
              Effect.fail(
                new KanbanError({
                  code: "io",
                  message: `Could not read the drafting thread "${run.threadId}".`,
                }),
              ),
            ),
          ),
        ),
      );
    const text = finalMessage(turnItems);
    if (text === undefined)
      return yield* close({
        id: attempt.id,
        status: "malformed",
        text: null,
        reason: "The drafting run finished without a message.",
      });
    const check = validateSpec(text);
    // The attempt first, then the issue file; see the order note on `SpecService`. The reactor runs
    // this inside the transaction that holds its cursor, so an admission that fails rolls the
    // attempt back to running and the event is retried.
    yield* close({
      id: attempt.id,
      status: check.valid ? "valid" : "malformed",
      text,
      reason: check.valid ? null : check.reason,
    });
    if (!check.valid) return;
    yield* admit({
      attemptId: attempt.id,
      projectId: attempt.project_id,
      issueId: attempt.issue_id,
      text,
      acceptance: check.acceptance,
      sourceHash: attempt.source_hash,
    });
  });

  const reconcile: SpecService["Service"]["reconcile"] = Effect.gen(function* () {
    // Only attempts older than this call: a request that arrives while it runs is not stranded.
    const startedAt = yield* nowIso;
    const rows = yield* sql<AttemptRow>`SELECT * FROM spec_attempt
        WHERE status = 'running' AND created_at < ${startedAt}`.pipe(
      Effect.catchTags({ SqlError: io }),
    );
    for (const row of rows) {
      const threadId = row.child_thread_id;
      const started =
        threadId === null
          ? false
          : yield* threads.getThreadShell(threadId).pipe(
              Effect.flatMap((shell) =>
                shell === null
                  ? Effect.succeed(false)
                  : Effect.map(
                      threads.getThreadRecords(threadId, ["runs"]),
                      ({ runs }) => runs.length > 0,
                    ),
              ),
              // A thread that cannot be read is not proven unstarted, so its attempt stays.
              Effect.catch((cause) =>
                Effect.logWarning("kanban: could not look up a drafting thread", { cause }).pipe(
                  Effect.as(true),
                ),
              ),
            );
      if (!started)
        yield* close({ id: row.id, status: "malformed", text: null, reason: NEVER_STARTED });
    }
  }).pipe(Effect.withSpan("SpecService.reconcile"));

  return SpecService.of({ specify, latest, finish, reconcile });
});

/** Over the plugin's `SqlClient`, which the host binds to `plugins/kanban.sqlite`. */
export const layer = Layer.effect(SpecService, make);
