import {
  CommandId,
  KanbanError,
  ThreadId,
  type KanbanGetIssueInput,
  type KanbanIssue,
  type KanbanSpecAttempt,
  type KanbanSpecifyInput,
  type KanbanSpecSource,
  type KanbanSpecStatus,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type ProjectId,
} from "@t3tools/contracts";
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

/** The run statuses that end a drafting thread's attempt. `waiting` still has a person to answer. */
const ENDED = new Set<OrchestrationV2Run["status"]>([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
]);

/**
 * Turns a Triage or Inbox issue into a checkable spec, one attempt per call. `specify` validates
 * the description as written, or starts a drafting thread in plan mode on routing's cheap tier;
 * `finish`, called by the reactor when that thread's run ends, validates what it wrote. A valid
 * spec admits the issue with its Acceptance items as criteria; a malformed one only records why.
 *
 * The attempt is stored, with its outcome, before the issue is admitted: admitting renames the
 * issue file, which no SQL transaction can cover, and a card admitted without an attempt would
 * have nothing to show for it. A crash between the two leaves a `valid` attempt for a card still
 * in Triage or Inbox. A person recovers it by calling `specify` again: the "already admitted"
 * refusal only applies once the card has left those columns.
 */
export class SpecService extends Context.Service<
  SpecService,
  {
    /**
     * Call from a request fiber: the drafting thread is launched with the thread launcher and the
     * routing plugin's tier service the caller's context holds.
     */
    readonly specify: (input: KanbanSpecifyInput) => Effect.Effect<KanbanSpecAttempt, KanbanError>;
    readonly latest: (
      input: KanbanGetIssueInput,
    ) => Effect.Effect<KanbanSpecAttempt | null, KanbanError>;
    /** Decides the running attempt whose drafting thread `run` belongs to, once the run has ended. */
    readonly finish: (run: OrchestrationV2Run) => Effect.Effect<void, KanbanError>;
  }
>()("t3/plugins/kanban/spec/SpecService") {}

interface AttemptRow {
  readonly id: number;
  readonly project_id: ProjectId;
  readonly issue_id: string;
  readonly source: KanbanSpecSource;
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

  const insert = (attempt: Omit<KanbanSpecAttempt, "id">) =>
    sql<{ readonly id: number }>`
      INSERT INTO spec_attempt
        (project_id, issue_id, source, child_thread_id, status, text, reason, created_at,
         completed_at)
      VALUES
        (${attempt.projectId}, ${attempt.issueId}, ${attempt.source}, ${attempt.childThreadId},
         ${attempt.status}, ${attempt.text}, ${attempt.reason}, ${attempt.createdAt},
         ${attempt.completedAt})
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

  const existing = Effect.fn("SpecService.existing")(function* (
    issue: KanbanIssue,
    projectId: ProjectId,
  ) {
    const check = validateSpec(issue.description);
    const createdAt = yield* nowIso;
    // The attempt first, then the issue file; see the order note on `SpecService`.
    const attempt = yield* insert({
      projectId,
      issueId: issue.id,
      source: "existing",
      childThreadId: null,
      status: check.valid ? "valid" : "malformed",
      text: issue.description,
      reason: check.valid ? null : check.reason,
      createdAt,
      completedAt: createdAt,
    }).pipe(Effect.catchTags({ SqlError: io }));
    if (check.valid) yield* store.admit(projectId, issue.id, "spec", check.acceptance);
    return attempt;
  });

  const draft = Effect.fn("SpecService.draft")(function* (
    issue: KanbanIssue,
    projectId: ProjectId,
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
              const attempt = yield* insert({
                projectId,
                issueId: issue.id,
                source: "child",
                childThreadId,
                status: "running",
                text: null,
                reason: null,
                createdAt: yield* nowIso,
                completedAt: null,
              }).pipe(Effect.catchTags({ SqlError: io }));
              yield* launches
                .launch({
                  commandId,
                  threadId: childThreadId,
                  projectId,
                  title: `Spec: ${issue.title}`,
                  modelSelection,
                  runtimeMode: "approval-required",
                  interactionMode: "plan",
                  workspaceStrategy: { type: "root" },
                  initialMessage: { text: draftingPrompt(issue), attachments: [] },
                  createdBy: "system",
                  creationSource: "server",
                })
                .pipe(
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
                  Effect.onError(() =>
                    sql`DELETE FROM spec_attempt WHERE id = ${attempt.id}`.pipe(Effect.ignore),
                  ),
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
  }) {
    const issue = yield* store.getIssue({ projectId, id });
    if (issue.status !== "triage" && issue.status !== "inbox")
      return yield* invalid("This ticket is already admitted.");
    return useExisting === true
      ? yield* existing(issue, projectId)
      : yield* draft(issue, projectId);
  });

  const latest: SpecService["Service"]["latest"] = ({ projectId, id }) =>
    sql<AttemptRow>`SELECT * FROM spec_attempt
      WHERE project_id = ${projectId} AND issue_id = ${id}
      ORDER BY id DESC LIMIT 1`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? null : toAttempt(rows[0]))),
      Effect.catchTags({ SqlError: io }),
    );

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
    if (check.valid)
      yield* store.admit(attempt.project_id, attempt.issue_id, "spec", check.acceptance);
  });

  return SpecService.of({ specify, latest, finish });
});

/** Over the plugin's `SqlClient`, which the host binds to `plugins/kanban.sqlite`. */
export const layer = Layer.effect(SpecService, make);
