import { CommandId, type ProjectId, ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";

const TITLE = "Weekly report";

/** One per project; seeding looks for this id and never touches a task that has it. */
const taskIdOf = (projectId: ProjectId) =>
  ScheduledTaskId.make(`telemetry-weekly-report:${projectId}`);

const promptFor = (projectId: ProjectId) =>
  [
    `Call the telemetry_report tool with projectId "${projectId}" and no from or to, which covers the last seven whole days.`,
    `Pass its html field unchanged to html_render, titled "${TITLE}", with a height of 2000.`,
    "Then reply with one sentence on what stands out.",
  ].join(" ");

/**
 * Gives each project with a default model a `Weekly report` thread and a scheduled task bound to
 * it that posts the report there every Monday at 09:00 in the server's time zone. A project that
 * already has the task is left alone, so a person's edits stay and disabling it stops it; a
 * project created later is seeded at the next start. The task runs Supervised, the lowest mode in
 * which the read-only `telemetry_report` and `html_render` tools run without asking. One project
 * failing does not stop the others. Answers with how many projects it seeded.
 */
export const seed = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const threads = yield* ThreadManagementService.ThreadManagementService;

  const existing = new Set<string>((yield* scheduledTasks.list()).tasks.map((task) => task.id));
  // Fresh ids per start: a project whose task and thread were both deleted gets new ones, not a
  // replay of the thread it had.
  const stamp = DateTime.toEpochMillis(yield* DateTime.now);
  let seeded = 0;
  for (const project of yield* projects.listShells()) {
    const modelSelection = project.defaultModelSelection;
    const id = taskIdOf(project.id);
    if (modelSelection === null || existing.has(id)) continue;
    const key = `telemetry-weekly-report:${project.id}:${stamp}`;
    const threadId = ThreadId.make(`thread:${key}`);
    const created = yield* Effect.result(
      Effect.gen(function* () {
        yield* threads.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`command:${key}`),
          threadId,
          projectId: project.id,
          title: TITLE,
          modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "system",
          creationSource: "server",
        });
        yield* scheduledTasks.upsert({
          id,
          title: TITLE,
          prompt: promptFor(project.id),
          enabled: true,
          schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1] },
          projectId: project.id,
          threadId,
          workspaceStrategy: { type: "root" },
          modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          createdBy: "system",
          creationSource: "server",
        });
      }),
    );
    if (Result.isFailure(created)) {
      yield* Effect.logWarning("telemetry: weekly report could not be seeded", {
        projectId: project.id,
        cause: created.failure,
      });
      continue;
    }
    seeded += 1;
  }
  return seeded;
});
