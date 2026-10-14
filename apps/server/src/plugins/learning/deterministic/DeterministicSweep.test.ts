import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type KanbanIssue,
  KanbanError,
  type KnowledgeEntry,
  KNOWLEDGE_MARKER_WORD,
  KnowledgeBody,
  KnowledgeError,
  KnowledgeKey,
  KnowledgeTitle,
  type OrchestrationProjectShell,
  type ScheduledTask,
  type TelemetryExtractionCandidate,
  type TelemetryMeasuresInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectService from "../../../project/ProjectService.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as Attention from "../../Attention.ts";
import * as HostDatabase from "../../HostDatabase.ts";
import * as KanbanStore from "../../kanban/KanbanStore.ts";
import * as KnowledgeStore from "../../knowledge/KnowledgeStore.ts";
import * as PluginDatabase from "../../PluginDatabase.ts";
import { existingTask, fakeCore, MODEL, project } from "../../telemetry/report/testkit.ts";
import * as Telemetry from "../../telemetry/Telemetry.ts";
import { migrations } from "../migrations.ts";
import * as PromptStore from "../prompts/PromptStore.ts";
import * as DeterministicSweep from "./DeterministicSweep.ts";
import * as ProposalStore from "./ProposalStore.ts";

const isKnowledgeKey = Schema.is(KnowledgeKey);
const isKnowledgeTitle = Schema.is(KnowledgeTitle);
const isKnowledgeBody = Schema.is(KnowledgeBody);

/** Wednesday 14 October 2026, so the week reviewed is Monday 5 to Monday 12 October. */
const NOW = Date.UTC(2026, 9, 14, 15, 30);
const WEEK_1 = "2026-10-05T00:00:00.000Z";
const WEEK_2 = "2026-10-12T00:00:00.000Z";
const WEEK_3 = "2026-10-19T00:00:00.000Z";

const projectA = project("project:a");
const projectB = project("project:b");

/** A candidate as telemetry answers it: a command and an inline script, found in three threads. */
const candidate = (
  id: string,
  overrides: Partial<TelemetryExtractionCandidate> = {},
): TelemetryExtractionCandidate => ({
  id,
  kind: "procedure",
  steps: ["command:vp test run src/a.test.ts", "script:node:0123456789ab"],
  threads: 3,
  occurrences: 4,
  deterministicRatio: 1,
  estimatedTokens: 1000,
  form: "script",
  example: { threadId: "thread:example", runId: "run:example", itemIds: ["item:a", "item:b"] },
  ...overrides,
});

const skill = (id: string, estimatedTokens: number) =>
  candidate(id, {
    steps: ["Grep <pattern> <path>", "Read <path>"],
    form: "skill",
    estimatedTokens,
  });

/**
 * The proposal store and the sweep over fresh learning and host databases, as the plugin's layer
 * builds them, with `projects` listed and a fake telemetry plugin that answers each window's
 * extraction candidates as `weeks` sets them by the window's first day. `tick` runs the sweep with
 * telemetry on and `services` beside it, as siblings a running plugin would add.
 */
const setup = (projects: ReadonlyArray<OrchestrationProjectShell> = [projectA]) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const { sql } = yield* PluginDatabase.open({
      id: "learning",
      filename: ":memory:",
      migrations,
    });
    const host = yield* PluginDatabase.open({
      id: "_host",
      filename: ":memory:",
      migrations: HostDatabase.migrations,
    });
    const context = yield* Layer.build(
      Layer.mergeAll(
        ProposalStore.layer,
        Attention.layer.pipe(Layer.provide(Layer.succeed(HostDatabase.HostDatabase, host.sql))),
      ).pipe(
        Layer.provideMerge(PromptStore.layer),
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.succeed(SqlClient.SqlClient, sql),
            NodeServices.layer,
            Layer.mock(ProjectService.ProjectService)({
              listShells: () => Effect.succeed(projects),
              getShell: (projectId) =>
                Effect.succeed(Option.fromNullishOr(projects.find((p) => p.id === projectId))),
            }),
          ),
        ),
      ),
    );
    const sweep = yield* DeterministicSweep.sweep.pipe(Effect.provide(context));
    const weeks = new Map<string, ReadonlyArray<TelemetryExtractionCandidate>>();
    const requests: Array<TelemetryMeasuresInput> = [];
    const telemetry = Telemetry.Telemetry.of({
      measures: (input) =>
        Effect.sync(() => {
          requests.push(input);
          const candidates = weeks.get(input.from) ?? [];
          return [
            {
              measure: "extraction_candidates",
              state: "ok" as const,
              value: candidates.length,
              unit: "count" as const,
              direction: "lower_is_better" as const,
              sampleSize: 3,
              missingReason: null,
              provenance: [],
              detail: { candidates },
            },
          ];
        }),
    });
    const store = Context.get(context, ProposalStore.ProposalStore);
    return {
      sql,
      weeks,
      requests,
      store,
      prompts: Context.get(context, PromptStore.PromptStore),
      tick: (services: Context.Context<never> = Context.empty(), dryRun = false) =>
        sweep
          .run({ dryRun })
          .pipe(Effect.provideService(Telemetry.Telemetry, telemetry), Effect.provide(services)),
      /** A project's proposals as `[candidate, state, tokens, week]`, newest first. */
      proposals: (projectId = projectA.id) =>
        store
          .list({ projectId })
          .pipe(
            Effect.map((list) =>
              list.map((p) => [p.candidateId, p.state, p.estimatedTokens, p.windowFrom]),
            ),
          ),
      /** Every flag ever raised, open or cleared, oldest first. */
      flags: host.sql<{
        readonly thread_id: string;
        readonly kind: string;
        readonly text: string;
        readonly resume_action: string;
        readonly cleared_at: string | null;
      }>`SELECT thread_id, kind, text, resume_action, cleared_at FROM attention ORDER BY id`,
    };
  });

it.effect(
  "a script candidate in three threads becomes one draft project script, once across two weeks",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* setup();
        world.weeks.set(WEEK_1, [candidate("c0ffee0000000001")]);

        // Reviewed, recorded, drafted and flagged in one tick.
        assert.deepEqual(yield* world.tick(), { examined: 2, acted: 3, flags: 1 });
        const [proposal] = yield* world.store.list({ projectId: projectA.id });
        assert.deepInclude(proposal, {
          state: "pending",
          form: "script",
          title: "vp test run src/a.test.ts → script:node:0123456789ab",
          estimatedTokens: 1000,
          windowFrom: WEEK_1,
          waitingReason: null,
        });
        // The command is the stored shape; a script's text is never kept, so its line names the
        // program and the item to copy it from.
        assert.deepEqual(proposal?.draft, {
          kind: "script",
          script: {
            id: "repeated-c0ffee000000",
            name: "Repeated: vp test run src/a.test.ts",
            command: [
              "vp test run src/a.test.ts",
              "# Paste the node script from item item:b in thread thread:example here.",
            ].join("\n"),
            icon: "play",
            runOnWorktreeCreate: false,
          },
        });

        // The same week again reviews nothing.
        assert.deepEqual(yield* world.tick(), { examined: 0, acted: 0, flags: 1 });

        // The next week finds the same candidate, costlier, and proposes nothing new.
        yield* TestClock.adjust("7 days");
        world.weeks.set(WEEK_2, [candidate("c0ffee0000000001", { estimatedTokens: 1500 })]);
        assert.deepEqual(yield* world.tick(), { examined: 1, acted: 0, flags: 1 });
        assert.deepEqual(yield* world.proposals(), [["c0ffee0000000001", "pending", 1000, WEEK_1]]);
        assert.deepEqual(
          world.requests.map((request) => [request.from, request.to]),
          [
            [WEEK_1, WEEK_2],
            [WEEK_2, WEEK_3],
          ],
        );

        // One flag for the project, opening the list on the Learning screen.
        const [flag, ...rest] = yield* world.flags;
        assert.deepEqual(rest, []);
        assert.deepInclude(flag, {
          thread_id: "deterministic:project:a",
          kind: "deterministic_proposals",
          text: "1 proposal to do repeated work without a model waits for review.",
          cleared_at: null,
        });
        assert.deepEqual(JSON.parse(flag!.resume_action), {
          label: "Review",
          target: "plugin",
          pluginId: "learning",
          tab: "deterministic",
        });
      }),
    ),
);

it.effect("a skill candidate becomes one proposed prompt in the library", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const world = yield* setup();
      world.weeks.set(WEEK_1, [skill("5c111a0000000001", 4000)]);
      yield* world.tick();
      yield* TestClock.adjust("7 days");
      world.weeks.set(WEEK_2, [skill("5c111a0000000001", 4000)]);
      yield* world.tick();

      const prompts = yield* world.prompts.list({ projectId: projectA.id });
      assert.deepEqual(
        prompts.map((p) => [p.kind, p.state, p.origin, p.title]),
        [
          [
            "workflow",
            "proposed",
            "repeated_work",
            "Repeated: Grep <pattern> <path> → Read <path>",
          ],
        ],
      );
      const [proposal] = yield* world.store.list({ projectId: projectA.id });
      const { prompt } = yield* world.prompts.get(prompts[0]!.id);
      // The draft names the prompt with what accepting activates.
      assert.deepEqual(proposal?.draft, {
        kind: "prompt",
        promptId: prompt.id,
        title: prompt.title,
        preview: prompt.body.slice(0, 200),
      });
      assert.include(prompt.body, "Grep <pattern> <path>\nRead <path>");
      assert.include(prompt.body, "thread thread:example");
    }),
  ),
);

it.effect("a dismissed candidate is not proposed again until its weekly cost doubles", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const world = yield* setup();
      world.weeks.set(WEEK_1, [skill("d15a110000000001", 1000)]);
      yield* world.tick();
      const [first] = yield* world.store.list({ projectId: projectA.id });

      const dismissed = yield* world.store.dismiss(
        { id: first!.id, reason: "Noise." },
        "user",
        "operate",
      );
      assert.deepInclude(dismissed, {
        state: "dismissed",
        decidedBy: "user",
        dismissReason: "Noise.",
      });
      // Its draft is withdrawn, and the flag clears once nothing is undecided.
      const [archived] = yield* world.prompts.list({ projectId: projectA.id });
      assert.strictEqual(archived?.state, "archived");
      assert.deepEqual(yield* world.tick(), { examined: 0, acted: 1, flags: 0 });
      assert.isNotNull((yield* world.flags)[0]?.cleared_at);

      // Not quite twice the cost: nothing.
      yield* TestClock.adjust("7 days");
      world.weeks.set(WEEK_2, [skill("d15a110000000001", 1999)]);
      assert.deepEqual(yield* world.tick(), { examined: 1, acted: 0, flags: 0 });

      // Twice the cost: proposed again, with a new draft beside the archived one.
      yield* TestClock.adjust("7 days");
      world.weeks.set(WEEK_3, [skill("d15a110000000001", 2000)]);
      yield* world.tick();
      assert.deepEqual(yield* world.proposals(), [
        ["d15a110000000001", "pending", 2000, WEEK_3],
        ["d15a110000000001", "dismissed", 1000, WEEK_1],
      ]);
      assert.deepEqual(
        (yield* world.prompts.list({ projectId: projectA.id })).map((p) => p.state),
        ["proposed", "archived"],
      );
      // A decided proposal is not decided again.
      const again = yield* Effect.flip(
        world.store.dismiss({ id: first!.id, reason: "x" }, "user", "operate"),
      );
      assert.strictEqual(again.code, "invalid");
    }),
  ),
);

it.effect("a project gets at most five proposals a week, the costliest eligible first", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const world = yield* setup([projectA, projectB]);
      const eligible = [100, 600, 300, 500, 200, 400].map((tokens) =>
        candidate(`e1191b1e0000${tokens}`, { estimatedTokens: tokens }),
      );
      const week = [
        ...eligible,
        // Costlier, but not deterministic enough, or in too few threads.
        candidate("1e55000000000001", { estimatedTokens: 9000, deterministicRatio: 0.79 }),
        candidate("1e55000000000002", { estimatedTokens: 8000, threads: 2 }),
      ];
      world.weeks.set(WEEK_1, week);
      yield* world.tick();
      for (const projectId of [projectA.id, projectB.id]) {
        assert.deepEqual(
          (yield* world.proposals(projectId)).map(([, , tokens]) => tokens),
          [200, 300, 400, 500, 600],
        );
      }
      assert.strictEqual(
        (yield* world.flags).find((flag) => flag.thread_id === "deterministic:project:b")?.text,
        "5 proposals to do repeated work without a model wait for review.",
      );

      // The next week proposes only the one left.
      yield* TestClock.adjust("7 days");
      world.weeks.set(WEEK_2, week);
      yield* world.tick();
      assert.deepEqual((yield* world.proposals()).slice(0, 2), [
        ["e1191b1e0000100", "pending", 100, WEEK_2],
        ["e1191b1e0000200", "pending", 200, WEEK_1],
      ]);
    }),
  ),
);

/**
 * An in-memory knowledge plugin with no pages, recording what it was asked. `failDiscard` makes a
 * discard fail as a locked database would; `setState` is a person acting on a page on its screen.
 */
const fakeKnowledge = Effect.gen(function* () {
  const pages = yield* Ref.make<ReadonlyArray<KnowledgeEntry>>([]);
  const failing = yield* Ref.make(false);
  const refusing = yield* Ref.make(false);
  const installs = yield* Ref.make(0);
  const setState = (id: number, state: KnowledgeEntry["state"]) =>
    Ref.update(pages, (all) => all.map((page) => (page.id === id ? { ...page, state } : page)));
  const layer = Layer.mock(KnowledgeStore.KnowledgeStore)({
    list: ({ projectId }) =>
      Effect.map(Ref.get(pages), (all) => all.filter((page) => page.projectId === projectId)),
    // Refuses what the real store refuses: text outside the contract, a key a live page of the
    // project holds, or anything while `refusing`.
    propose: (input, source) =>
      Effect.gen(function* () {
        const taken = (yield* Ref.get(pages)).some(
          (page) =>
            page.projectId === input.projectId &&
            page.key === input.key &&
            page.state !== "retired",
        );
        if (
          (yield* Ref.get(refusing)) ||
          taken ||
          !isKnowledgeKey(input.key) ||
          !isKnowledgeTitle(input.title) ||
          !isKnowledgeBody(input.body)
        ) {
          return yield* new KnowledgeError({ code: "invalid", message: "The page is invalid." });
        }
        return yield* Ref.modify(pages, (all) => {
          const page: KnowledgeEntry = {
            id: all.length + 1,
            ...input,
            state: "draft",
            source,
            createdAt: WEEK_2,
            acceptedAt: null,
            retiredAt: null,
          };
          return [page, [...all, page]];
        });
      }),
    discard: ({ id }) =>
      Effect.gen(function* () {
        if (yield* Ref.get(failing)) {
          return yield* new KnowledgeError({ code: "io", message: "Could not discard the draft." });
        }
        yield* setState(id, "retired");
        return (yield* Ref.get(pages)).find((page) => page.id === id)!;
      }),
    accept: ({ id }) =>
      Effect.gen(function* () {
        yield* setState(id, "accepted");
        return (yield* Ref.get(pages)).find((page) => page.id === id)!;
      }),
    install: () =>
      Effect.as(
        Ref.update(installs, (count) => count + 1),
        [],
      ),
  });
  return {
    context: yield* Layer.build(layer),
    pages: Ref.get(pages),
    installs: Ref.get(installs),
    failDiscard: (fail: boolean) => Ref.set(failing, fail),
    refuseProposals: (refuse: boolean) => Ref.set(refusing, refuse),
    setState,
    /** A page a person saved, under `key`, in `state`. */
    seed: (key: string, state: KnowledgeEntry["state"]) =>
      Ref.update(pages, (all) => [
        ...all,
        {
          id: all.length + 1,
          projectId: projectA.id,
          key,
          title: "Our architecture",
          body: "Written by hand.",
          state,
          source: { kind: "person" as const },
          createdAt: WEEK_1,
          acceptedAt: null,
          retiredAt: null,
        },
      ]),
  };
});

it.effect("a page a person saved under a draft's key is never accepted or discarded for it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const world = yield* setup();
      const knowledge = yield* fakeKnowledge;
      // A person's own pages, a draft and an accepted one, under the keys the drafts would take.
      yield* knowledge.seed("repeated-c0de000000000011", "draft");
      yield* knowledge.seed("repeated-c0de000000000012", "accepted");
      const reads = (id: string, path: string) =>
        candidate(id, { steps: [`Read ${path}`], form: "context_file" });
      world.weeks.set(WEEK_1, [
        reads("c0de000000000011", "docs/arch.md"),
        reads("c0de000000000012", "docs/setup.md"),
      ]);
      yield* world.tick(knowledge.context);

      // Each draft is a page of its own, under the next free key.
      const [first, second] = (yield* world.store.list({ projectId: projectA.id })).toReversed();
      assert.deepEqual(
        [first, second].map((p) => (p?.draft?.kind === "knowledge" ? p.draft.key : null)),
        ["repeated-c0de000000000011-2", "repeated-c0de000000000012-2"],
      );
      yield* world.store.accept(first!.id, "settingsWrite").pipe(Effect.provide(knowledge.context));
      yield* world.store
        .dismiss({ id: second!.id, reason: "Covered." }, "user", "settingsWrite")
        .pipe(Effect.provide(knowledge.context));
      assert.deepEqual(
        (yield* knowledge.pages).map((page) => [page.key, page.state, page.source.kind]),
        [
          ["repeated-c0de000000000011", "draft", "person"],
          ["repeated-c0de000000000012", "accepted", "person"],
          ["repeated-c0de000000000011-2", "accepted", "agent"],
          ["repeated-c0de000000000012-2", "retired", "agent"],
        ],
      );
    }),
  ),
);

it.effect(
  "steps with a path longer than a page are cut so the page and the prompt fit their contracts",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* setup();
        const knowledge = yield* fakeKnowledge;
        const longPath = `docs/${"deep/".repeat(1500)}notes.md`;
        world.weeks.set(WEEK_1, [
          candidate("1009000000000001", { steps: [`Read ${longPath}`], form: "context_file" }),
          candidate("1009000000000002", {
            steps: [`Grep <pattern> ${longPath}`, `Read ${longPath}`],
            form: "skill",
          }),
        ]);
        yield* world.tick(knowledge.context);

        assert.deepEqual(
          (yield* world.store.list({ projectId: projectA.id })).map((p) => [p.form, p.state]),
          [
            ["skill", "pending"],
            ["context_file", "pending"],
          ],
        );
        const [page] = yield* knowledge.pages;
        assert.isTrue(isKnowledgeBody(page!.body) && isKnowledgeTitle(page!.title));
        const [prompt] = yield* world.prompts.list({ projectId: projectA.id });
        assert.isAtMost((yield* world.prompts.get(prompt!.id)).prompt.body.length, 10_000);
      }),
    ),
);

it.effect("a knowledge title never holds the index block's marker, even when a step does", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const world = yield* setup();
      const knowledge = yield* fakeKnowledge;
      world.weeks.set(WEEK_1, [
        candidate("3a7c000000000001", {
          steps: ["Grep fork-knowledge: AGENTS.md", "Read fork-fork-knowledge:knowledge:x.md"],
          form: "context_file",
        }),
      ]);
      yield* world.tick(knowledge.context);
      const [page] = yield* knowledge.pages;
      // Removing the inner marker of `fork-fork-knowledge:knowledge:` leaves one, which goes too.
      assert.strictEqual(page?.title, "What runs read first: Grep AGENTS.md → Read x.md");
      assert.isFalse(page!.title.includes(KNOWLEDGE_MARKER_WORD));
    }),
  ),
);

it.effect("an empty command step drafts a script with a comment in its place", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const world = yield* setup();
      world.weeks.set(WEEK_1, [candidate("e3c7000000000001", { steps: ["command:  "] })]);
      yield* world.tick();
      const [proposal] = yield* world.store.list({ projectId: projectA.id });
      assert.strictEqual(proposal?.state, "pending");
      assert.deepInclude(proposal?.draft, {
        kind: "script",
        script: {
          id: "repeated-e3c700000000",
          name: "Repeated: (empty command)",
          command:
            "# A command with no text was recorded; see item item:a in thread thread:example.",
          icon: "play",
          runOnWorktreeCreate: false,
        },
      });
    }),
  ),
);

it.effect("a draft its target refuses is dismissed by the sweep instead of waiting for good", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const world = yield* setup();
      const knowledge = yield* fakeKnowledge;
      yield* knowledge.refuseProposals(true);
      world.weeks.set(WEEK_1, [
        candidate("5ef0000000000001", { steps: ["Read docs/arch.md"], form: "context_file" }),
      ]);
      // Recorded, refused and dismissed in one tick, so no flag waits on it.
      assert.deepEqual(yield* world.tick(knowledge.context), { examined: 2, acted: 1, flags: 0 });
      const [proposal] = yield* world.store.list({ projectId: projectA.id });
      assert.deepInclude(proposal, {
        state: "dismissed",
        decidedBy: "supervisor",
        dismissReason: "The draft could not be saved: The page is invalid.",
        draft: null,
      });
      // Nothing is waiting, so the next tick tries nothing.
      yield* knowledge.refuseProposals(false);
      assert.deepEqual(yield* world.tick(knowledge.context), { examined: 0, acted: 0, flags: 0 });
      assert.deepEqual(yield* knowledge.pages, []);
    }),
  ),
);

it.effect("a context file waits while the knowledge plugin is off, then becomes a draft page", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const world = yield* setup();
      world.weeks.set(WEEK_1, [
        candidate("c0de000000000001", { steps: ["Read docs/arch.md"], form: "context_file" }),
      ]);
      // Recorded and flagged, but with no draft.
      assert.deepEqual(yield* world.tick(), { examined: 2, acted: 2, flags: 1 });
      const [waiting] = yield* world.store.list({ projectId: projectA.id });
      assert.deepInclude(waiting, {
        state: "waiting",
        draft: null,
        waitingReason: "The knowledge plugin is off.",
      });

      const knowledge = yield* fakeKnowledge;
      assert.deepEqual(yield* world.tick(knowledge.context), { examined: 1, acted: 1, flags: 1 });
      const [page] = yield* knowledge.pages;
      assert.deepInclude(page, {
        key: "repeated-c0de000000000001",
        title: "What runs read first: Read docs/arch.md",
        state: "draft",
        source: { kind: "agent", threadId: ThreadId.make("thread:example") },
      });
      const [pending] = yield* world.store.list({ projectId: projectA.id });
      assert.deepInclude(pending, {
        state: "pending",
        draft: {
          kind: "knowledge",
          pageId: 1,
          key: "repeated-c0de000000000001",
          title: "What runs read first: Read docs/arch.md",
        },
      });
    }),
  ),
);

it.effect("a scheduled task is a paused draft on the project's default model", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const modelless = project("project:modelless", null);
      const world = yield* setup([projectA, modelless]);
      const core = yield* fakeCore({ projects: [projectA, modelless] });
      world.weeks.set(WEEK_1, [
        candidate("7a5c000000000001", { steps: ["command:vp run audit"], form: "scheduled_task" }),
      ]);
      yield* world.tick(yield* Layer.build(core.layer));

      const [task] = yield* core.tasks;
      const [proposal] = yield* world.store.list({ projectId: projectA.id });
      assert.deepInclude(task, {
        title: "Repeated: vp run audit",
        enabled: false,
        projectId: projectA.id,
        modelSelection: MODEL,
        runtimeMode: "approval-required",
      });
      assert.deepEqual(proposal?.draft, {
        kind: "scheduled_task",
        taskId: task!.id,
        createdAt: task!.createdAt,
        title: task!.title,
        prompt: task!.prompt,
      });
      // A project without a default model has nothing for the task to run on.
      const [waiting] = yield* world.store.list({ projectId: modelless.id });
      assert.deepInclude(waiting, {
        state: "waiting",
        waitingReason: "The project has no default model for a task to run on.",
      });
    }),
  ),
);

it.effect("a task draft runs on the model a project's settings give it, not only its shell's", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const configured = project("project:configured", null);
      const world = yield* setup([configured]);
      const core = yield* fakeCore({ projects: [configured] });
      const settings = ServerSettings.layerTest({
        projectSettingsFolded: true,
        projectSettingsOverrides: { [configured.id]: { defaultModelSelection: MODEL } },
      });
      world.weeks.set(WEEK_1, [
        candidate("7a5c000000000002", { steps: ["command:vp run audit"], form: "scheduled_task" }),
      ]);
      yield* world.tick(yield* Layer.build(Layer.merge(core.layer, settings)));

      const [task] = yield* core.tasks;
      assert.deepInclude(task, { projectId: configured.id, modelSelection: MODEL });
      const [proposal] = yield* world.store.list({ projectId: configured.id });
      assert.strictEqual(proposal?.state, "pending");
    }),
  ),
);

/**
 * Scheduled tasks kept in memory, each saved with a creation time of its own, as the real service
 * keeps one per task and an edit keeps it. `tasks` starts with `seeded`.
 */
const fakeTasks = (seeded: ReadonlyArray<ScheduledTask>) =>
  Effect.gen(function* () {
    const tasks = yield* Ref.make(seeded);
    let saves = 0;
    const layer = Layer.mock(ScheduledTaskService.ScheduledTaskService)({
      list: () => Effect.map(Ref.get(tasks), (all) => ({ tasks: all })),
      upsert: ({ schedule, ...saved }) =>
        Effect.gen(function* () {
          if (schedule.type === "webhook") return yield* Effect.die("No webhook tasks here.");
          saves += 1;
          const task: ScheduledTask = {
            ...existingTask(saved.id ?? `task:${saves}`, saved.projectId),
            title: saved.title,
            prompt: saved.prompt,
            enabled: saved.enabled,
            schedule,
            createdBy: saved.createdBy ?? "user",
            createdAt: `2026-10-${String(10 + saves).padStart(2, "0")}T00:00:00.000Z`,
          };
          yield* Ref.update(tasks, (all) => [...all.filter((t) => t.id !== task.id), task]);
          return { task };
        }),
      setEnabled: ({ id, enabled }) =>
        Effect.gen(function* () {
          yield* Ref.update(tasks, (all) =>
            all.map((task) => (task.id === id ? { ...task, enabled } : task)),
          );
          return { task: (yield* Ref.get(tasks)).find((task) => task.id === id)! };
        }),
      delete: ({ id }) =>
        Effect.as(
          Ref.update(tasks, (all) => all.filter((task) => task.id !== id)),
          { id },
        ),
    });
    return { context: yield* Layer.build(layer), tasks: Ref.get(tasks) };
  });

it.effect("a task someone else saved under a draft's id is never enabled or deleted for it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const world = yield* setup();
      // A person's own tasks, under the ids the first two proposals' drafts would take.
      const theirs = [
        existingTask("learning-repeated-work:1", projectA.id),
        existingTask("learning-repeated-work:2", projectA.id),
      ];
      const service = yield* fakeTasks(theirs);
      const daily = (id: string, command: string) =>
        candidate(id, { steps: [`command:${command}`], form: "scheduled_task" });
      world.weeks.set(WEEK_1, [
        daily("7a5c000000000002", "vp run audit"),
        daily("7a5c000000000003", "vp run report"),
      ]);
      yield* world.tick(service.context);

      // Each draft takes the next free id, beside the person's task.
      const proposals = (yield* world.store.list({ projectId: projectA.id })).toReversed();
      assert.deepEqual(
        proposals.map((p) => (p.draft?.kind === "scheduled_task" ? String(p.draft.taskId) : null)),
        ["learning-repeated-work:1-2", "learning-repeated-work:2-2"],
      );
      yield* world.store.accept(proposals[0]!.id, "operate").pipe(Effect.provide(service.context));
      yield* world.store
        .dismiss({ id: proposals[1]!.id, reason: "Not daily." }, "user", "operate")
        .pipe(Effect.provide(service.context));
      const after = yield* service.tasks;
      assert.deepEqual(
        after.map((task) => [task.id, task.enabled]),
        [
          ["learning-repeated-work:1", false],
          ["learning-repeated-work:2", false],
          ["learning-repeated-work:1-2", true],
        ],
      );

      // A draft's task deleted and saved again by someone else is not its task any more.
      yield* TestClock.adjust("7 days");
      world.weeks.set(WEEK_2, [daily("7a5c000000000004", "vp run sync")]);
      yield* world.tick(service.context);
      const [third] = yield* world.store.list({ projectId: projectA.id, state: "pending" });
      const draft = third?.draft;
      if (third === undefined || draft?.kind !== "scheduled_task") {
        return assert.fail("Expected a task draft.");
      }
      yield* Effect.provide(
        ScheduledTaskService.ScheduledTaskService.pipe(
          Effect.flatMap((tasks) =>
            tasks.delete({ id: draft.taskId }).pipe(
              Effect.andThen(
                tasks.upsert({
                  ...existingTask(draft.taskId, projectA.id),
                  createdBy: "user",
                  schedule: { type: "fixed_time", timeOfDay: "17:00" },
                }),
              ),
            ),
          ),
        ),
        service.context,
      );
      const refused = yield* Effect.flip(
        world.store.accept(third.id, "operate").pipe(Effect.provide(service.context)),
      );
      assert.strictEqual(refused.message, "The scheduled task was deleted; dismiss this proposal.");
      yield* world.store
        .dismiss({ id: third.id, reason: "Gone." }, "user", "operate")
        .pipe(Effect.provide(service.context));
      const replaced = (yield* service.tasks).find((task) => task.id === draft.taskId);
      assert.deepInclude(replaced, { enabled: false, title: "My own report" });
    }),
  ),
);

/** An in-memory board, which files and moves cards. */
const fakeKanban = Effect.gen(function* () {
  const issues = yield* Ref.make<ReadonlyArray<KanbanIssue>>([]);
  const find = (id: string | undefined) =>
    Effect.flatMap(Ref.get(issues), (all) => {
      const issue = all.find((entry) => entry.id === id);
      return issue === undefined
        ? Effect.fail(new KanbanError({ code: "not_found", message: `No issue ${id}.` }))
        : Effect.succeed(issue);
    });
  const save = (issue: KanbanIssue) =>
    Ref.update(issues, (all) => [...all.filter((entry) => entry.id !== issue.id), issue]);
  const layer = Layer.mock(KanbanStore.KanbanStore)({
    board: () =>
      Effect.map(Ref.get(issues), (all) => ({
        directory: "/wiki/project-a",
        capture: false,
        issues: all.map(({ criteria: _c, findings: _f, description: _d, log: _l, ...issue }) => ({
          ...issue,
          criteriaOpen: 0,
          criteriaTotal: 0,
        })),
        decisionCategories: [],
      })),
    getIssue: ({ id }) => find(id),
    write: (_projectId, actor, write) =>
      Effect.gen(function* () {
        if (write.action === "issue.create") {
          const id = `card-${(yield* Ref.get(issues)).length + 1}`;
          yield* save({
            id,
            title: write.title ?? "",
            status: write.status ?? "triage",
            priority: "p3",
            labels: write.labels ?? [],
            verification: "unverified",
            tier: null,
            blocked: null,
            reopened: null,
            threads: [],
            createdAt: WEEK_2,
            createdBy: actor,
            updatedAt: WEEK_2,
            doneAt: null,
            archivedAt: null,
            criteria: [],
            findings: [],
            closureCheck: true,
            noDecision: null,
            description: write.description ?? "",
            log: [],
          });
          return { id };
        }
        const issue = yield* find(write.id);
        yield* save(
          write.action === "issue.archive"
            ? { ...issue, archivedAt: WEEK_2 }
            : { ...issue, status: write.status ?? issue.status },
        );
        return { id: issue.id };
      }),
  });
  return { context: yield* Layer.build(layer), issues: Ref.get(issues) };
});

it.effect(
  "work that needs code is a Triage card labeled deterministic; dismissing archives it",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* setup();
        const kanban = yield* fakeKanban;
        world.weeks.set(WEEK_1, [
          candidate("4007000000000001", { steps: ["command:vp fmt <path>"], form: "hook" }),
        ]);
        yield* world.tick(kanban.context);
        const [card] = yield* kanban.issues;
        assert.deepInclude(card, {
          title: "Could be deterministic: vp fmt <path>",
          status: "triage",
          labels: ["deterministic"],
          createdBy: "system",
        });
        assert.include(card!.description, "a hook the provider runs after an edit");

        const [proposal] = yield* world.store.list({ projectId: projectA.id });
        assert.deepEqual(proposal?.draft, {
          kind: "kanban",
          issueId: card!.id,
          title: "Could be deterministic: vp fmt <path>",
        });

        // With the board off the card cannot be archived, so the proposal stays undecided.
        const off = yield* Effect.flip(
          world.store.dismiss(
            { id: proposal!.id, reason: "We format on save." },
            "user",
            "operate",
          ),
        );
        assert.deepEqual(
          [off.code, off.message],
          ["inactive", "The kanban plugin is off; turn it on so the card can be archived."],
        );
        assert.strictEqual(
          (yield* world.store.list({ projectId: projectA.id }))[0]?.state,
          "pending",
        );
        assert.isNull((yield* kanban.issues)[0]?.archivedAt);

        yield* world.store
          .dismiss({ id: proposal!.id, reason: "We format on save." }, "user", "operate")
          .pipe(Effect.provide(kanban.context));
        assert.isNotNull((yield* kanban.issues)[0]?.archivedAt);
      }),
    ),
);

it.effect("dismissing archives a draft card a person moved to Inbox", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const world = yield* setup();
      const kanban = yield* fakeKanban;
      world.weeks.set(WEEK_1, [
        candidate("4007000000000002", { steps: ["command:vp fmt <path>"], form: "hook" }),
      ]);
      yield* world.tick(kanban.context);
      const [card] = yield* kanban.issues;
      yield* Effect.flatMap(KanbanStore.KanbanStore, (store) =>
        store.write(projectA.id, "user", { action: "issue.move", id: card!.id, status: "inbox" }),
      ).pipe(Effect.provide(kanban.context));

      const [proposal] = yield* world.store.list({ projectId: projectA.id });
      yield* world.store
        .dismiss({ id: proposal!.id, reason: "Not worth a hook." }, "user", "operate")
        .pipe(Effect.provide(kanban.context));
      const [after] = yield* kanban.issues;
      assert.strictEqual(after?.status, "inbox");
      assert.isNotNull(after?.archivedAt);
    }),
  ),
);

it.effect(
  "a card proposal dismissed and proposed again at twice the cost files a new card that accepting moves to Todo",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* setup();
        const kanban = yield* fakeKanban;
        const hook = (estimatedTokens: number) =>
          candidate("4007000000000002", {
            steps: ["command:vp fmt <path>"],
            form: "hook",
            estimatedTokens,
          });
        world.weeks.set(WEEK_1, [hook(1000)]);
        yield* world.tick(kanban.context);
        const [first] = yield* world.store.list({ projectId: projectA.id });
        yield* world.store
          .dismiss({ id: first!.id, reason: "Not yet." }, "user", "operate")
          .pipe(Effect.provide(kanban.context));

        yield* TestClock.adjust("7 days");
        world.weeks.set(WEEK_2, [hook(2000)]);
        yield* world.tick(kanban.context);
        const [again] = yield* world.store.list({ projectId: projectA.id, state: "pending" });
        const cards = yield* kanban.issues;
        // The first card stays archived; the new proposal has a card of its own.
        assert.deepEqual(
          cards.map((card) => [card.id, card.status, card.archivedAt === null]),
          [
            ["card-1", "triage", false],
            ["card-2", "triage", true],
          ],
        );
        assert.deepInclude(again?.draft, { kind: "kanban", issueId: "card-2" });

        const accepted = yield* world.store
          .accept(again!.id, "operate")
          .pipe(Effect.provide(kanban.context));
        assert.strictEqual(accepted.state, "accepted");
        assert.strictEqual(
          (yield* kanban.issues).find((card) => card.id === "card-2")?.status,
          "todo",
        );
      }),
    ),
);

it.effect(
  "a dismissal fails while its draft cannot be withdrawn, and goes through once a person acted on it",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* setup();
        const knowledge = yield* fakeKnowledge;
        world.weeks.set(WEEK_1, [
          candidate("d15c000000000001", { steps: ["Read docs/arch.md"], form: "context_file" }),
        ]);
        yield* world.tick(knowledge.context);
        const [proposal] = yield* world.store.list({ projectId: projectA.id });
        const dismiss = world.store
          .dismiss({ id: proposal!.id, reason: "Already in AGENTS.md." }, "user", "settingsWrite")
          .pipe(Effect.provide(knowledge.context));

        // The draft page cannot be discarded: nothing is recorded, and a retry can follow.
        yield* knowledge.failDiscard(true);
        const failed = yield* Effect.flip(dismiss);
        assert.deepEqual([failed.code, failed.message], ["io", "Could not discard the draft."]);
        assert.strictEqual(
          (yield* world.store.list({ projectId: projectA.id }))[0]?.state,
          "pending",
        );

        // A person accepted the page on its own screen: nothing is left to withdraw, and the page stays.
        yield* knowledge.setState(1, "accepted");
        assert.deepInclude(yield* dismiss, {
          state: "dismissed",
          dismissReason: "Already in AGENTS.md.",
        });
        assert.strictEqual((yield* knowledge.pages)[0]?.state, "accepted");
      }),
    ),
);

it.effect("accepting a page that was accepted but never installed installs it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const world = yield* setup();
      const knowledge = yield* fakeKnowledge;
      world.weeks.set(WEEK_1, [
        candidate("d15c000000000002", { steps: ["Read docs/arch.md"], form: "context_file" }),
      ]);
      yield* world.tick(knowledge.context);
      const [proposal] = yield* world.store.list({ projectId: projectA.id });
      // An earlier accept saved the page as accepted, then its install failed.
      yield* knowledge.setState(1, "accepted");

      const accepted = yield* world.store
        .accept(proposal!.id, "settingsWrite")
        .pipe(Effect.provide(knowledge.context));
      assert.strictEqual(accepted.state, "accepted");
      assert.strictEqual(yield* knowledge.installs, 1);
    }),
  ),
);

it.effect("accepting a draft script adds it to the project's scripts, once", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const world = yield* setup();
      world.weeks.set(WEEK_1, [candidate("acce970000000001")]);
      yield* world.tick();
      const [proposal] = yield* world.store.list({ projectId: projectA.id });
      const settings = yield* Layer.build(ServerSettings.layerTest());

      const accepted = yield* world.store
        .accept(proposal!.id, "settingsWrite")
        .pipe(Effect.provide(settings));
      assert.deepInclude(accepted, { state: "accepted", decidedBy: "user" });
      const saved = yield* Effect.provide(
        ServerSettings.ServerSettingsService.pipe(Effect.flatMap((s) => s.getSettings)),
        settings,
      );
      assert.deepEqual(
        saved.projectSettingsOverrides[projectA.id]?.defaultProjectScripts?.map((s) => s.id),
        ["repeated-acce97000000"],
      );
      // Accepted once: a second accept is refused, and the flag clears on the next tick.
      const again = yield* Effect.flip(
        world.store.accept(proposal!.id, "settingsWrite").pipe(Effect.provide(settings)),
      );
      assert.strictEqual(again.code, "invalid");
      assert.deepEqual(yield* world.tick(), { examined: 0, acted: 1, flags: 0 });
    }),
  ),
);

it.effect(
  "accepting a script whose id a person's action holds adds it under the next free id and leaves theirs",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* setup();
        world.weeks.set(WEEK_1, [candidate("acce970000000002")]);
        yield* world.tick();
        const [proposal] = yield* world.store.list({ projectId: projectA.id });
        const mine = {
          id: "repeated-acce97000000",
          name: "Mine",
          command: "make mine",
          icon: "play",
          runOnWorktreeCreate: false,
        } as const;
        const settings = yield* Layer.build(
          ServerSettings.layerTest({
            projectSettingsOverrides: { [projectA.id]: { defaultProjectScripts: [mine] } },
          }),
        );

        const draft = proposal?.draft;
        if (draft?.kind !== "script") return assert.fail("Expected a script draft.");
        yield* world.store.accept(proposal!.id, "settingsWrite").pipe(Effect.provide(settings));
        const saved = yield* Effect.provide(
          ServerSettings.ServerSettingsService.pipe(Effect.flatMap((s) => s.getSettings)),
          settings,
        );
        assert.deepEqual(saved.projectSettingsOverrides[projectA.id]?.defaultProjectScripts, [
          mine,
          { ...draft.script, id: "repeated-acce97000000-2" },
        ]);
      }),
    ),
);

it.effect(
  "a list carries at most six steps, each cut to 300 characters, and the row keeps them whole",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* setup();
        const long = `Read ${"deep/".repeat(1000)}notes.md`;
        const steps = [
          long,
          ...Array.from({ length: 7 }, (_, index) => `Grep step-${index} <path>`),
        ];
        yield* world.store.propose({
          projectId: projectA.id,
          windowFrom: WEEK_1,
          candidates: [candidate("b0d0000000000001", { steps, form: "skill" })],
          dryRun: false,
        });

        const [listed] = yield* world.store.list({ projectId: projectA.id });
        assert.strictEqual(listed?.steps.length, 6);
        assert.strictEqual(listed?.steps[0]?.length, 300);
        assert.isTrue(listed?.steps[0]?.endsWith("…"));
        assert.deepEqual(listed?.steps.slice(1), steps.slice(1, 6));
        const [row] = yield* world.sql<{ readonly candidate: string }>`
        SELECT candidate FROM deterministic_proposals`;
        assert.deepEqual(
          (JSON.parse(row!.candidate) as { readonly steps: ReadonlyArray<string> }).steps,
          steps,
        );
      }),
    ),
);

it.effect("every undecided proposal is listed first, however many were decided after it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const world = yield* setup();
      world.weeks.set(WEEK_1, [candidate("01d0000000000001")]);
      yield* world.tick();
      // 120 proposals decided since, each newer than the one still pending.
      for (let index = 0; index < 120; index += 1) {
        yield* world.sql`INSERT INTO deterministic_proposals ${world.sql.insert({
          project_id: projectA.id,
          candidate_id: `decided-${index}`,
          form: "script",
          candidate: JSON.stringify(candidate(`decided-${index}`)),
          estimated_tokens: 1000,
          window_from: WEEK_1,
          state: "dismissed",
          draft: null,
          waiting_reason: null,
          decided_by: "user",
          decided_at: WEEK_2,
          dismiss_reason: "Noise.",
          created_at: WEEK_2,
          updated_at: WEEK_2,
        })}`;
      }

      const listed = yield* world.store.list({ projectId: projectA.id });
      assert.strictEqual(listed.length, 100);
      assert.deepEqual(
        listed.slice(0, 2).map((proposal) => [proposal.candidateId, proposal.state]),
        [
          ["01d0000000000001", "pending"],
          ["decided-119", "dismissed"],
        ],
      );
      assert.deepEqual(
        (yield* world.store.list({ projectId: projectA.id, state: "pending" })).map(
          (proposal) => proposal.candidateId,
        ),
        ["01d0000000000001"],
      );
      assert.strictEqual(
        (yield* world.store.list({ projectId: projectA.id, state: "dismissed" })).length,
        100,
      );
    }),
  ),
);

it.effect("a dry run counts what it would propose and writes nothing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const world = yield* setup();
      world.weeks.set(WEEK_1, [candidate("d040000000000001")]);
      assert.deepEqual(yield* world.tick(Context.empty(), true), {
        examined: 1,
        acted: 1,
        flags: 0,
      });
      assert.deepEqual(yield* world.proposals(), []);
      assert.deepEqual(yield* world.flags, []);
      // The real run still reviews the week.
      assert.deepEqual(yield* world.tick(), { examined: 2, acted: 3, flags: 1 });
    }),
  ),
);
