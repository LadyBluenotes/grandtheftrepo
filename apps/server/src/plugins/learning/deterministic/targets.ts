import {
  type DeterministicDraft,
  type KanbanActor,
  LearningError,
  MAX_SCRIPT_ID_LENGTH,
  PROMPT_PREVIEW_LENGTH,
  type ProjectId,
  ScheduledTaskId,
  type TelemetryExtractionCandidate,
  ThreadId,
} from "@t3tools/contracts";
import { resolveProjectScripts } from "@t3tools/shared/projectScripts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ProjectService from "../../../project/ProjectService.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as KanbanStore from "../../kanban/KanbanStore.ts";
import * as KnowledgeStore from "../../knowledge/KnowledgeStore.ts";
import * as PromptStore from "../prompts/PromptStore.ts";
import {
  CARD_LABEL,
  cardDraft,
  knowledgeDraft,
  promptDraft,
  scriptDraft,
  taskDraft,
} from "./drafts.ts";

/** A proposal as its form's target sees it. */
interface Proposed {
  readonly id: number;
  readonly projectId: ProjectId;
  readonly candidate: TelemetryExtractionCandidate;
  readonly windowFrom: string;
}

/** A draft saved in its target, or why there is none yet. */
/**
 * A draft saved in its target; or why there is none yet, which the next sweep tries again; or why
 * the target refused it, which no retry changes.
 */
type Drafted =
  | { readonly _tag: "drafted"; readonly draft: DeterministicDraft }
  | { readonly _tag: "waiting"; readonly reason: string }
  | { readonly _tag: "rejected"; readonly reason: string };

const waiting = (reason: string): Drafted => ({ _tag: "waiting", reason });
const drafted = (draft: DeterministicDraft): Drafted => ({ _tag: "drafted", draft });

const inactive = (message: string) => new LearningError({ code: "inactive", message });
const invalid = (message: string) => new LearningError({ code: "invalid", message });

/** A sibling's own error, as the learning plugin answers it; `gated` is a refusal like `invalid`. */
const relay = (error: {
  readonly code: "inactive" | "not_found" | "invalid" | "gated" | "io";
  readonly message: string;
}) =>
  Effect.fail(
    new LearningError({
      code: error.code === "gated" ? "invalid" : error.code,
      message: error.message,
    }),
  );

const failedTo = (what: string) => (cause: unknown) =>
  Effect.logWarning(`learning: ${what} failed`, { cause }).pipe(
    Effect.andThen(Effect.fail(new LearningError({ code: "io", message: `Could not ${what}.` }))),
  );

/**
 * `id`, or when an action of the project holds it, the first of `id-2`, `id-3`, ... that none
 * holds, cut so it stays a valid script id.
 */
const freeScriptId = (id: string, taken: ReadonlySet<string>) => {
  if (!taken.has(id)) return id;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const next = `${id.slice(0, MAX_SCRIPT_ID_LENGTH - suffix.length)}${suffix}`;
    if (!taken.has(next)) return next;
  }
};

/**
 * Whether `task` is the draft's own task: the same id and the creation time the draft recorded,
 * which a person's edits keep. One deleted and saved again under that id, by anyone, is not.
 */
const ownsTask = (
  task: { readonly id: string; readonly createdAt: string },
  draft: { readonly taskId: string; readonly createdAt: string },
) => task.id === draft.taskId && task.createdAt === draft.createdAt;

/** The id a proposal's paused task is saved under first, so a retry finds it instead of adding one. */
const taskIdOf = (proposalId: number) =>
  ScheduledTaskId.make(`learning-repeated-work:${proposalId}`);

/**
 * Where each form's draft goes, and how it is accepted or withdrawn there. The prompt library is
 * this plugin's own; project scripts and scheduled tasks are the core's, and the knowledge and
 * kanban plugins are siblings, so those are read where the call runs and may be absent.
 */
export const make = Effect.gen(function* () {
  const prompts = yield* PromptStore.PromptStore;
  const projects = yield* ProjectService.ProjectService;
  const knowledge = Effect.serviceOption(KnowledgeStore.KnowledgeStore);
  const kanban = Effect.serviceOption(KanbanStore.KanbanStore);
  const tasks = Effect.serviceOption(ScheduledTaskService.ScheduledTaskService);
  const settings = Effect.serviceOption(ServerSettings.ServerSettingsService);

  /**
   * Saves the proposal's draft in its target. Each save finds the draft an earlier try saved: the
   * prompt by its source key, the page by its key, the task by its id and the card by its title
   * and label. A target that is off, or a project without a default model for a task to run on,
   * leaves the proposal waiting; so does a save that fails, which is logged.
   */
  const draft = (proposal: Proposed) =>
    Effect.gen(function* () {
      const { candidate, projectId, windowFrom } = proposal;
      switch (candidate.form) {
        case "script":
          return drafted({ kind: "script", script: scriptDraft(candidate) });
        case "skill": {
          const prompt = yield* prompts.proposeFrom({
            projectId,
            ...promptDraft(candidate, windowFrom),
            origin: "repeated_work",
            sourceKey: `deterministic:${proposal.id}`,
          });
          return drafted({
            kind: "prompt",
            promptId: prompt.id,
            title: prompt.title,
            preview: prompt.body.slice(0, PROMPT_PREVIEW_LENGTH),
          });
        }
        case "context_file": {
          const store = yield* knowledge;
          if (Option.isNone(store)) return waiting("The knowledge plugin is off.");
          const text = knowledgeDraft(candidate, windowFrom);
          const pages = yield* store.value.list({ projectId });
          const saved = pages.find((page) => page.key === text.key && page.state !== "retired");
          const page =
            saved ??
            (yield* store.value.propose(
              { projectId, ...text },
              { kind: "agent", threadId: ThreadId.make(candidate.example.threadId) },
            ));
          return drafted({ kind: "knowledge", pageId: page.id, key: page.key, title: page.title });
        }
        case "scheduled_task": {
          const service = yield* tasks;
          if (Option.isNone(service)) return waiting("Scheduled tasks are not available.");
          const text = taskDraft(candidate, windowFrom);
          const saved = (yield* service.value.list()).tasks;
          // The first of `<base>`, `<base>-2`, ... that no task holds, or that holds the paused
          // task an earlier try saved: the system's, with this text. A task someone else saved
          // under one of these ids is passed over, never taken as this draft.
          let id = taskIdOf(proposal.id);
          for (let n = 2; ; n += 1) {
            const task = saved.find((entry) => entry.id === id);
            if (task === undefined) break;
            if (
              task.createdBy === "system" &&
              task.title === text.title &&
              task.prompt === text.prompt
            ) {
              return drafted({
                kind: "scheduled_task",
                taskId: id,
                createdAt: task.createdAt,
                ...text,
              });
            }
            id = ScheduledTaskId.make(`${taskIdOf(proposal.id)}-${n}`);
          }
          const shell = yield* projects.getShell(projectId);
          const modelSelection = Option.isSome(shell) ? shell.value.defaultModelSelection : null;
          if (modelSelection === null) {
            return waiting("The project has no default model for a task to run on.");
          }
          const { task } = yield* service.value.upsert({
            id,
            ...text,
            enabled: false,
            schedule: { type: "fixed_time", timeOfDay: "09:00" },
            projectId,
            threadId: null,
            workspaceStrategy: { type: "root" },
            modelSelection,
            runtimeMode: "approval-required",
            interactionMode: "default",
            createdBy: "system",
            creationSource: "server",
          });
          return drafted({
            kind: "scheduled_task",
            taskId: id,
            createdAt: task.createdAt,
            ...text,
          });
        }
        case "mcp_tool":
        case "hook": {
          const store = yield* kanban;
          if (Option.isNone(store)) return waiting("The kanban plugin is off.");
          const card = cardDraft(candidate, windowFrom, proposal.id);
          // A card an earlier try filed has this title and label, and names the proposal. An
          // archived one is never it: the board keeps a dismissed proposal's card archived.
          let saved: string | undefined;
          for (const issue of (yield* store.value.board(projectId)).issues) {
            if (issue.archivedAt !== null) continue;
            if (issue.title !== card.title || !issue.labels.includes(CARD_LABEL)) continue;
            const full = yield* store.value.getIssue({ projectId, id: issue.id });
            if (full.description.includes(card.marker)) saved = issue.id;
          }
          const issueId =
            saved ??
            (yield* store.value.write(projectId, "system", {
              action: "issue.create",
              title: card.title,
              description: card.description,
              status: "triage",
              labels: [CARD_LABEL],
            })).id;
          return drafted({ kind: "kanban", issueId, title: card.title });
        }
      }
    }).pipe(
      Effect.catch((cause) => {
        // A store that refuses the text refuses it again; anything else may pass next time.
        const refused = "code" in cause && (cause.code === "invalid" || cause.code === "gated");
        return Effect.logWarning("learning: a deterministic proposal's draft could not be saved", {
          proposalId: proposal.id,
          cause,
        }).pipe(
          Effect.as<Drafted>(
            refused
              ? { _tag: "rejected", reason: cause.message }
              : waiting("The draft could not be saved; the next sweep tries again."),
          ),
        );
      }),
    );

  /** Applies a draft in its target; one already applied there is left as it is. */
  const accept = (projectId: ProjectId, draft: DeterministicDraft) =>
    Effect.gen(function* () {
      switch (draft.kind) {
        case "script": {
          const service = yield* settings;
          if (Option.isNone(service)) {
            return yield* inactive("Project settings are not available on this server.");
          }
          const shell = yield* projects.getShell(projectId);
          if (Option.isNone(shell)) return yield* invalid(`Project ${projectId} no longer exists.`);
          const current = yield* service.value.getSettings;
          const scripts = resolveProjectScripts(current, shell.value);
          // Added already, by an earlier try: an action with the draft's name and command, under
          // its id or the one it was given beside a person's action of that id.
          const applied = scripts.some(
            (script) =>
              script.name === draft.script.name && script.command === draft.script.command,
          );
          if (applied) return;
          const id = freeScriptId(draft.script.id, new Set(scripts.map((script) => script.id)));
          yield* service.value.updateSettings({
            projectSettingsOverrides: {
              [projectId]: {
                ...current.projectSettingsOverrides[projectId],
                defaultProjectScripts: [...scripts, { ...draft.script, id }],
              },
            },
          });
          return;
        }
        case "prompt": {
          const { prompt } = yield* prompts.get(draft.promptId);
          if (prompt.state === "archived") {
            return yield* invalid(
              "The prompt was archived in the library; unarchive it there, or dismiss this proposal.",
            );
          }
          if (prompt.state === "proposed") yield* prompts.accept(prompt.id);
          return;
        }
        case "knowledge": {
          const store = yield* knowledge;
          if (Option.isNone(store)) return yield* inactive("The knowledge plugin is off.");
          const page = (yield* store.value.list({ projectId })).find(
            (entry) => entry.id === draft.pageId,
          );
          if (page === undefined || page.state === "retired") {
            return yield* invalid("The knowledge draft was discarded; dismiss this proposal.");
          }
          // An accepted page whose install failed is installed again, so a retry finishes the job.
          if (page.state === "draft") yield* store.value.accept({ id: page.id });
          else yield* store.value.install({ projectId });
          return;
        }
        case "scheduled_task": {
          const service = yield* tasks;
          if (Option.isNone(service)) return yield* inactive("Scheduled tasks are not available.");
          const task = (yield* service.value.list()).tasks.find((entry) => ownsTask(entry, draft));
          if (task === undefined) {
            return yield* invalid("The scheduled task was deleted; dismiss this proposal.");
          }
          if (!task.enabled) yield* service.value.setEnabled({ id: task.id, enabled: true });
          return;
        }
        case "kanban": {
          const store = yield* kanban;
          if (Option.isNone(store)) return yield* inactive("The kanban plugin is off.");
          const issue = yield* store.value.getIssue({ projectId, id: draft.issueId });
          if (issue.archivedAt !== null) {
            return yield* invalid("The card was archived; dismiss this proposal.");
          }
          if (issue.status === "triage" || issue.status === "inbox") {
            yield* store.value.write(projectId, "user", {
              action: "issue.move",
              id: issue.id,
              status: "todo",
            });
          }
          return;
        }
      }
    }).pipe(
      Effect.catchTags({
        KnowledgeError: relay,
        KanbanError: relay,
        ScheduledTaskError: failedTo("save the scheduled task"),
        ServerSettingsError: failedTo("save the project's scripts"),
        ProjectOperationError: failedTo("read the project"),
      }),
    );

  /**
   * Withdraws a draft its target still holds undecided: archives the proposed prompt, discards the
   * knowledge draft, deletes the paused task and archives the Triage card, as `by`. A draft a person
   * already acted on in its target, or that is gone, is left alone. A target that is off, or a
   * withdrawal that fails, fails the call, so the dismissal waits until the draft can go.
   */
  const withdraw = (projectId: ProjectId, draft: DeterministicDraft, by: KanbanActor) =>
    Effect.gen(function* () {
      switch (draft.kind) {
        case "script":
          return;
        case "prompt": {
          const { prompt } = yield* prompts.get(draft.promptId);
          if (prompt.state === "proposed") yield* prompts.archive(prompt.id);
          return;
        }
        case "knowledge": {
          const store = yield* knowledge;
          if (Option.isNone(store)) {
            return yield* inactive(
              "The knowledge plugin is off; turn it on so the draft page can be discarded.",
            );
          }
          const page = (yield* store.value.list({ projectId })).find(
            (entry) => entry.id === draft.pageId,
          );
          if (page?.state === "draft") yield* store.value.discard({ id: page.id });
          return;
        }
        case "scheduled_task": {
          const service = yield* tasks;
          if (Option.isNone(service)) {
            return yield* inactive(
              "Scheduled tasks are not available, so the task cannot be deleted.",
            );
          }
          const task = (yield* service.value.list()).tasks.find((entry) => ownsTask(entry, draft));
          if (task !== undefined && !task.enabled) yield* service.value.delete({ id: task.id });
          return;
        }
        case "kanban": {
          const store = yield* kanban;
          if (Option.isNone(store)) {
            return yield* inactive(
              "The kanban plugin is off; turn it on so the card can be archived.",
            );
          }
          const issue = yield* store.value.getIssue({ projectId, id: draft.issueId }).pipe(
            Effect.map(Option.some),
            // A card deleted since needs no withdrawing.
            Effect.catchIf(
              (error) => error.code === "not_found",
              () => Effect.succeedNone,
            ),
          );
          if (
            Option.isSome(issue) &&
            (issue.value.status === "triage" || issue.value.status === "inbox") &&
            issue.value.archivedAt === null
          ) {
            yield* store.value.write(projectId, by, {
              action: "issue.archive",
              id: issue.value.id,
            });
          }
          return;
        }
      }
    }).pipe(
      Effect.catchTags({
        KnowledgeError: relay,
        KanbanError: relay,
        ScheduledTaskError: failedTo("delete the scheduled task"),
      }),
    );

  return { draft, accept, withdraw };
});
