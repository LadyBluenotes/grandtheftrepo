import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId, type Project } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../../config.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as Attention from "../../Attention.ts";
import { flagKeyedToProject } from "../../attentionKeys.ts";
import * as HostDatabase from "../../HostDatabase.ts";
import * as PluginDatabase from "../../PluginDatabase.ts";
import * as KanbanStore from "../KanbanStore.ts";
import * as FindingService from "./FindingService.ts";
import * as UnownedSweep from "./UnownedSweep.ts";

const project = (id: string, title: string): Project => ({
  id: ProjectId.make(id),
  title,
  workspaceRoot: "/unused",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  deletedAt: null,
});
const withBoard = project("project-1", "Grand Theft Repo");
/** A project nobody opened a board for. */
const withoutBoard = project("project-2", "Quiet Repo");
const projectId = withBoard.id;
const finder = ThreadId.make("thr_finder");

/** Set while checking whether a folder exists fails, as a permission error makes it. */
const existsCheck = { fails: false };

/** A fresh board folder per test, over two projects. */
const layerTest = FindingService.layer.pipe(
  Layer.provideMerge(KanbanStore.layer),
  Layer.provide(
    Layer.effect(
      FileSystem.FileSystem,
      Effect.map(FileSystem.FileSystem, (real) => ({
        ...real,
        exists: (path) =>
          existsCheck.fails
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "exists",
                  description: "EACCES: permission denied",
                }),
              )
            : real.exists(path),
      })),
    ),
  ),
  Layer.provideMerge(
    Layer.mock(ProjectService.ProjectService)({
      getById: (id) =>
        Effect.succeed(Option.fromUndefinedOr([withBoard, withoutBoard].find((p) => p.id === id))),
      listShells: () => Effect.succeed([withBoard, withoutBoard]),
    }),
  ),
  Layer.provideMerge(
    Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-unowned-test-" })),
  ),
  Layer.provideMerge(NodeServices.layer),
);

interface FlagRow {
  readonly id: number;
  readonly plugin_id: string;
  readonly thread_id: string;
  readonly kind: string;
  readonly text: string;
  readonly resume_action: string;
  readonly cleared_at: string | null;
}

/** The sweep over the test's board and a migrated in-memory host database. */
const fixture = Effect.gen(function* () {
  const { sql } = yield* PluginDatabase.open({
    id: "_host",
    filename: ":memory:",
    migrations: HostDatabase.migrations,
  });
  const attention = Attention.layer.pipe(
    Layer.provide(Layer.succeed(HostDatabase.HostDatabase, sql)),
  );
  const run = yield* UnownedSweep.sweep.pipe(Effect.provide(attention));
  return {
    /** A flag as an earlier server run left it. */
    raise: (text: string) =>
      Effect.flatMap(Attention.Attention, (flags) =>
        flags.raise({
          pluginId: "kanban",
          threadId: `findings:${projectId}`,
          kind: "unowned_finding",
          text,
          resumeAction: { label: "Open board", target: "board" },
        }),
      ).pipe(Effect.provide(attention)),
    /** One supervisor tick of the sweep. */
    tick: (dryRun = false) => run({ dryRun }),
    flags: sql<FlagRow>`SELECT * FROM attention ORDER BY id`,
    open: sql<FlagRow>`SELECT * FROM attention WHERE cleared_at IS NULL ORDER BY id`,
    /** Rows this connection has inserted, updated or deleted since it opened. */
    changes: sql<{ readonly n: number }>`SELECT total_changes() AS n`.pipe(
      Effect.map((rows) => rows[0]?.n ?? 0),
    ),
  };
});

/** Searches, then captures one finding as an agent: on `issueId`, or on a new Triage card. */
const capture = (title: string, issueId?: string) =>
  Effect.gen(function* () {
    const findings = yield* FindingService.FindingService;
    const { searchId } = yield* findings.search({ projectId, threadId: finder, query: title });
    return yield* findings.capture({
      projectId,
      threadId: finder,
      searchId,
      title,
      evidence: "Seen in the server log.",
      truthStatus: "seen",
      scopeRelation: "unrelated",
      issueId,
    });
  });

const review = (id: string) =>
  Effect.flatMap(FindingService.FindingService, (findings) =>
    findings.review({ projectId, id, disposition: "fix_now", reason: "Mine now." }, "user"),
  );

it.effect(
  "an unowned Triage finding raises one flag after three days, and a review clears it next tick",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { tick, flags, open, changes } = yield* fixture;
        const { finding } = yield* capture("Retry loop has no backoff");

        yield* TestClock.adjust("71 hours");
        assert.deepEqual(yield* tick(), { examined: 1, acted: 0, flags: 0 });
        assert.deepEqual(yield* flags, []);

        yield* TestClock.adjust("1 hour");
        // A dry run counts the flag it would raise and writes nothing.
        assert.deepEqual(yield* tick(true), { examined: 1, acted: 0, flags: 1 });
        assert.deepEqual(yield* flags, []);

        assert.deepEqual(yield* tick(), { examined: 1, acted: 1, flags: 1 });
        const [flag, ...rest] = yield* open;
        assert.strictEqual(rest.length, 0);
        assert.include(flag, {
          plugin_id: "kanban",
          kind: "unowned_finding",
          thread_id: "findings:project-1",
          text: "1 finding in Triage has had no owner for over 3 days; review it to take it on.",
        });
        assert.deepEqual(JSON.parse(flag?.resume_action ?? ""), {
          label: "Open board",
          target: "board",
        });
        // Keyed to the project, so the board's strip and the weekly report list it.
        assert.isTrue(flagKeyedToProject(flag?.thread_id ?? "", projectId));

        // Nothing changed, so the next tick writes nothing.
        const unchanged = yield* changes;
        assert.deepEqual(yield* tick(), { examined: 1, acted: 0, flags: 1 });
        assert.strictEqual(yield* changes, unchanged);

        // A review takes it on; the next tick clears the flag.
        yield* review(finding.id);
        assert.deepEqual(yield* tick(), { examined: 1, acted: 1, flags: 0 });
        assert.deepEqual(yield* open, []);
        const [cleared, ...history] = yield* flags;
        assert.strictEqual(history.length, 0);
        assert.strictEqual(cleared?.id, flag?.id);
        assert.isString(cleared?.cleared_at);

        const settled = yield* changes;
        assert.deepEqual(yield* tick(), { examined: 1, acted: 0, flags: 0 });
        assert.strictEqual(yield* changes, settled);
      }),
    ).pipe(Effect.provide(layerTest)),
);

it.effect("ten old findings in one project raise one flag with the count", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { tick, open } = yield* fixture;
      const store = yield* KanbanStore.KanbanStore;
      const captured = yield* Effect.forEach(
        Array.from({ length: 10 }, (_, i) => i + 1),
        (n) => capture(`Finding number ${n}`),
      );
      // A finding on a card past Triage is that card's work, not an unowned one.
      const { id: todo } = yield* store.write(projectId, "user", {
        action: "issue.create",
        title: "Harden the retry helper",
        status: "todo",
      });
      yield* capture("Retry helper swallows errors", todo);

      yield* TestClock.adjust("3 days");
      assert.deepEqual(yield* tick(), { examined: 10, acted: 1, flags: 1 });
      const [flag, ...rest] = yield* open;
      assert.strictEqual(rest.length, 0);
      assert.strictEqual(
        flag?.text,
        "10 findings in Triage have had no owner for over 3 days; review each to take it on.",
      );

      // The count follows the findings on the same flag.
      yield* review(captured[0]!.finding.id);
      assert.deepEqual(yield* tick(), { examined: 10, acted: 1, flags: 1 });
      const [rewritten, ...others] = yield* open;
      assert.strictEqual(others.length, 0);
      assert.strictEqual(rewritten?.id, flag?.id);
      assert.include(rewritten?.text ?? "", "9 findings in Triage");

      // The project without a board was looked at without creating one.
      const fs = yield* FileSystem.FileSystem;
      assert.isFalse(yield* fs.exists(yield* store.directory(withoutBoard.id)));
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("a finding left on two cards counts once, by its most recently reviewed copy", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { tick, open } = yield* fixture;
      const store = yield* KanbanStore.KanbanStore;
      const { finding } = yield* capture("Retry loop has no backoff");
      const { id: second } = yield* store.write(projectId, "user", {
        action: "issue.create",
        title: "Retry loop has no backoff",
        status: "triage",
      });
      // What a move or review that failed halfway leaves: the second card holds an unreviewed copy.
      const copyOnSecond = store.transact(projectId, (issues) =>
        Effect.succeed({
          result: undefined,
          save: [{ ...issues.get(second)!, findings: [finding] }],
        }),
      );
      yield* copyOnSecond;

      yield* TestClock.adjust("3 days");
      assert.deepEqual(yield* tick(), { examined: 1, acted: 1, flags: 1 });
      assert.include(
        (yield* open)[0]?.text ?? "",
        "1 finding in Triage has had no owner for over 3 days",
      );

      // The review reached the first card's copy only; the reviewed copy is the canonical one.
      yield* review(finding.id);
      yield* copyOnSecond;
      assert.deepEqual(yield* tick(), { examined: 1, acted: 1, flags: 0 });
      assert.deepEqual(yield* open, []);
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("a board whose folder cannot be checked keeps its flag; a missing folder clears it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { tick, open, raise } = yield* fixture;
      // Raised before a restart; this server has not loaded the board yet.
      yield* raise(
        "1 finding in Triage has had no owner for over 3 days; review it to take it on.",
      );

      existsCheck.fails = true;
      const unread = yield* tick().pipe(
        Effect.ensuring(Effect.sync(() => (existsCheck.fails = false))),
      );
      assert.deepEqual(unread, { examined: 0, acted: 0, flags: 1 });
      assert.strictEqual((yield* open).length, 1);

      // Once the check works, the folder is known to be missing: no board, so no finding.
      assert.deepEqual(yield* tick(), { examined: 0, acted: 1, flags: 0 });
      assert.deepEqual(yield* open, []);
    }),
  ).pipe(Effect.provide(layerTest)),
);
