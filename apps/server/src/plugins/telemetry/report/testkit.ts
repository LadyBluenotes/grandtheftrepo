import {
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderInstanceId,
  type ScheduledTask,
  ScheduledTaskId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";

export const MODEL: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5",
};

export const project = (
  id: string,
  defaultModelSelection: ModelSelection | null = MODEL,
): OrchestrationProjectShell => ({
  id: ProjectId.make(id),
  title: `Project ${id}`,
  workspaceRoot: `/work/${id}`,
  defaultModelSelection,
  scripts: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
});

/** A task a person already has, edited away from what seeding would write. */
export const existingTask = (id: string, projectId: ProjectId): ScheduledTask => ({
  id: ScheduledTaskId.make(id),
  title: "My own report",
  prompt: "Report the week my way.",
  enabled: false,
  schedule: { type: "fixed_time", timeOfDay: "17:00", weekdays: [5] },
  projectId,
  threadId: null,
  workspaceStrategy: { type: "root" },
  modelSelection: MODEL,
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
});

/**
 * Projects, a scheduled task service and thread management that keep what they are given in
 * memory, so a test can read back the tasks and threads seeding made. `upserted` completes on the
 * first save. The thread service lists no threads, so a report sees only the plugin's own rows.
 */
export const fakeCore = (input: {
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly tasks?: ReadonlyArray<ScheduledTask>;
}) =>
  Effect.gen(function* () {
    const tasks = yield* Ref.make<ReadonlyArray<ScheduledTask>>(input.tasks ?? []);
    const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
    const upserted = yield* Deferred.make<void>();
    const layer = Layer.mergeAll(
      Layer.mock(ProjectService.ProjectService)({
        listShells: () => Effect.succeed(input.projects),
        getShell: (projectId) =>
          Effect.succeed(Option.fromNullishOr(input.projects.find((p) => p.id === projectId))),
      }),
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({
        list: () => Effect.map(Ref.get(tasks), (all) => ({ tasks: all })),
        upsert: ({ schedule, ...saved }) =>
          Effect.gen(function* () {
            if (schedule.type === "webhook") return yield* Effect.die("No webhook tasks here.");
            const task: ScheduledTask = {
              ...existingTask(saved.id ?? "scheduled-task:new", saved.projectId),
              title: saved.title,
              prompt: saved.prompt,
              enabled: saved.enabled,
              schedule,
              threadId: saved.threadId ?? null,
              workspaceStrategy: saved.workspaceStrategy,
              modelSelection: saved.modelSelection,
              runtimeMode: saved.runtimeMode,
              interactionMode: saved.interactionMode,
              createdBy: saved.createdBy ?? "user",
              creationSource: saved.creationSource ?? "web",
            };
            yield* Ref.update(tasks, (all) => [...all.filter((t) => t.id !== task.id), task]);
            yield* Deferred.succeed(upserted, undefined);
            return { task };
          }),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        dispatch: (command) =>
          Ref.update(commands, (all) => [...all, command]).pipe(
            Effect.as({ sequence: 1, storedEvents: [] }),
          ),
        listProjectThreads: () => Effect.succeed([]),
        getThreadShell: () => Effect.succeed(null),
      }),
    );
    return {
      layer,
      tasks: Ref.get(tasks),
      commands: Ref.get(commands),
      upserted: Deferred.await(upserted),
    };
  });
