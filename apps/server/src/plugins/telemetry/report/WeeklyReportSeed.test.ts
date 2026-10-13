import { assert, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { existingTask, fakeCore, MODEL, project } from "./testkit.ts";
import * as WeeklyReportSeed from "./WeeklyReportSeed.ts";

it.effect("gives each project with a default model one task, bound to a new thread", () =>
  Effect.gen(function* () {
    const core = yield* fakeCore({
      projects: [project("project:a"), project("project:b"), project("project:no-model", null)],
    });
    const seed = WeeklyReportSeed.seed.pipe(Effect.provide(core.layer));

    assert.strictEqual(yield* seed, 2);
    const tasks = yield* core.tasks;
    const commands = yield* core.commands;
    assert.deepEqual(
      tasks.map((task) => task.id),
      ["telemetry-weekly-report:project:a", "telemetry-weekly-report:project:b"],
    );
    // Each task posts into the thread created for it, in the same project.
    assert.deepEqual(
      commands.map((command) =>
        command.type === "thread.create"
          ? [command.projectId, command.threadId, command.title, command.runtimeMode]
          : [command.type],
      ),
      tasks.map((task) => [task.projectId, task.threadId, "Weekly report", "approval-required"]),
    );
    const [first] = tasks;
    assert.deepEqual(first?.schedule, { type: "fixed_time", timeOfDay: "09:00", weekdays: [1] });
    assert.deepInclude(first, {
      title: "Weekly report",
      enabled: true,
      modelSelection: MODEL,
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdBy: "system",
      creationSource: "server",
    });
    assert.include(first?.prompt ?? "", 'telemetry_report tool with projectId "project:a"');
    assert.include(first?.prompt ?? "", "html_render");

    // A second start finds every task and creates nothing.
    assert.strictEqual(yield* seed, 0);
    assert.deepEqual(yield* core.tasks, tasks);
    assert.strictEqual((yield* core.commands).length, commands.length);
  }),
);

it.effect("leaves a project's existing task as the person left it", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:edited");
    const mine = existingTask(`telemetry-weekly-report:${projectId}`, projectId);
    const core = yield* fakeCore({ projects: [project(projectId)], tasks: [mine] });

    assert.strictEqual(yield* WeeklyReportSeed.seed.pipe(Effect.provide(core.layer)), 0);
    assert.deepEqual(yield* core.tasks, [mine]);
    assert.deepEqual(yield* core.commands, []);
  }),
);
