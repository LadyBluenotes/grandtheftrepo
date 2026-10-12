import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import type { PluginMigration } from "./Plugin.ts";
import * as PluginDatabase from "./PluginDatabase.ts";
import { PluginHost, make, resolve } from "./PluginHost.ts";
import { registry } from "./registry.ts";

const plugins = [
  { id: "telemetry", dependsOn: [] },
  { id: "learning", dependsOn: ["telemetry", "review"] },
  { id: "review", dependsOn: [] },
];

const layerConfig = Layer.fresh(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3code-plugin-host-test-" }),
);

const layerHost = Layer.effect(PluginHost, make(plugins)).pipe(Layer.provideMerge(layerConfig));

it("runs a plugin only when it and every dependency are enabled, in any registry order", () => {
  const statusOf = (enabled: Record<string, boolean>, id: string) => {
    const status = resolve(plugins, enabled).find((candidate) => candidate.id === id);
    if (!status) throw new Error(`no status for ${id}`);
    return status;
  };

  assert.isTrue(statusOf({}, "learning").active);
  assert.isFalse(statusOf({ review: false }, "review").active);
  const learning = statusOf({ review: false }, "learning");
  assert.isTrue(learning.enabled);
  assert.isFalse(learning.active);
  assert.deepEqual(learning.missing, ["review"]);
  assert.deepEqual(statusOf({ learning: false }, "learning"), {
    id: "learning",
    dependsOn: ["telemetry", "review"],
    enabled: false,
    active: false,
    missing: [],
    startError: null,
  });
  assert.deepEqual(resolve([{ id: "kanban", dependsOn: ["ghost"] }], {})[0]?.missing, ["ghost"]);
});

it.layer(NodeServices.layer)("plugin host", (it) => {
  it.effect("saves the choice to plugins.json without changing what runs until restart", () =>
    Effect.gen(function* () {
      const host = yield* PluginHost;
      assert.deepEqual([...host.activeIds], ["telemetry", "learning", "review"]);

      const after = yield* host.setEnabled("review", false);
      assert.deepEqual(
        after.map((status) => [status.id, status.enabled, status.active]),
        [
          ["telemetry", true, true],
          ["learning", true, false],
          ["review", false, false],
        ],
      );
      assert.deepEqual([...host.activeIds], ["telemetry", "learning", "review"]);

      const { stateDir } = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      assert.strictEqual(
        yield* fs.readFileString(path.join(stateDir, "plugins.json")),
        '{\n  "review": false\n}\n',
      );
      assert.deepEqual(
        (yield* host.statuses).map((status) => status.active),
        [true, false, false],
      );
    }).pipe(Effect.provide(layerHost)),
  );

  it.effect("refuses an unknown plugin and a plugin whose dependency is off", () =>
    Effect.gen(function* () {
      const host = yield* PluginHost;
      const unknown = yield* Effect.flip(host.setEnabled("ghost", true));
      assert.strictEqual(unknown.message, 'Unknown plugin "ghost".');

      yield* host.setEnabled("telemetry", false);
      const refused = yield* Effect.flip(host.setEnabled("learning", true));
      assert.strictEqual(refused.message, "Enable telemetry before learning.");
    }).pipe(Effect.provide(layerHost)),
  );
});

it("names every registered plugin with a lowercase id, never a host-reserved one", () => {
  for (const plugin of registry) assert.match(plugin.id, /^[a-z][a-z0-9-]*$/);
});

const statement = (text: string): PluginMigration[2] =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(text);
  });

const tableNames = (sql: SqlClient.SqlClient) =>
  Effect.map(
    sql<{
      readonly name: string;
    }>`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
    (rows) => rows.map((row) => row.name),
  );

const appliedIds = (sql: SqlClient.SqlClient) =>
  Effect.map(
    sql<{
      readonly migration_id: number;
    }>`SELECT migration_id FROM effect_sql_migrations ORDER BY migration_id`,
    (rows) => rows.map((row) => row.migration_id),
  );

/** One boot of the host for `plugins`, inside the caller's scope and state directory. */
const boot = (plugins: Parameters<typeof make>[0]) =>
  Effect.map(Layer.build(Layer.effect(PluginHost, make(plugins))), (services) =>
    Context.get(services, PluginHost),
  );

const database = (host: PluginHost["Service"], id: string) => {
  const sql = host.databases.get(id);
  if (sql === undefined) throw new Error(`no database for ${id}`);
  return sql;
};

it.layer(NodeServices.layer)("plugin databases", (it) => {
  it.effect("gives each plugin its own file with only its tables, kept across boots", () =>
    Effect.gen(function* () {
      const plugins = [
        {
          id: "a",
          dependsOn: [],
          migrations: [[1, "init", statement("CREATE TABLE a_rows (v TEXT)")]],
        },
        {
          id: "b",
          dependsOn: ["a"],
          migrations: [[1, "init", statement("CREATE TABLE b_rows (v TEXT)")]],
        },
        { id: "memory", dependsOn: [] },
      ] as const;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* boot(plugins);
          assert.deepEqual([...host.activeIds], ["a", "b", "memory"]);
          const a = database(host, "a");
          yield* a`INSERT INTO a_rows (v) VALUES ('kept')`;
          assert.deepEqual(yield* tableNames(a), ["a_rows", "effect_sql_migrations"]);
          assert.deepEqual(yield* tableNames(database(host, "b")), [
            "b_rows",
            "effect_sql_migrations",
          ]);
          assert.deepEqual(yield* tableNames(database(host, "memory")), ["effect_sql_migrations"]);
        }),
      );
      assert.isTrue(yield* fs.exists(path.join(stateDir, "plugins", "a.sqlite")));
      assert.isTrue(yield* fs.exists(path.join(stateDir, "plugins", "b.sqlite")));
      assert.isFalse(yield* fs.exists(path.join(stateDir, "plugins", "memory.sqlite")));
      assert.isFalse(yield* fs.exists(path.join(stateDir, "statev2.sqlite")));

      yield* Effect.scoped(
        Effect.gen(function* () {
          const a = database(yield* boot(plugins), "a");
          const rows = yield* a<{ readonly v: string }>`SELECT v FROM a_rows`;
          assert.deepEqual(
            rows.map((row) => row.v),
            ["kept"],
          );
          assert.deepEqual(yield* appliedIds(a), [1]);
        }),
      );
    }).pipe(Effect.provide(layerConfig)),
  );

  it.effect("a failing migration keeps the plugin and its dependents out for the boot", () =>
    Effect.gen(function* () {
      const plugins = (second: PluginMigration[2]) =>
        [
          { id: "fine", dependsOn: [] },
          {
            id: "bad",
            dependsOn: [],
            migrations: [
              [1, "init", statement("CREATE TABLE bad_rows (v TEXT)")],
              [2, "more", second],
            ],
          },
          { id: "child", dependsOn: ["bad"] },
        ] as const;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;
      const filename = path.join(stateDir, "plugins", "bad.sqlite");

      yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* boot(plugins(Effect.die(new Error("boom"))));
          assert.deepEqual([...host.activeIds], ["fine"]);
          const statuses = yield* host.statuses;
          const errorOf = (id: string) => statuses.find((status) => status.id === id)?.startError;
          assert.isNull(errorOf("fine"));
          assert.isString(errorOf("bad"));
          assert.strictEqual(errorOf("child"), 'Dependency "bad" failed to start.');
          const reopened = yield* PluginDatabase.open({ id: "bad", filename, migrations: [] });
          assert.deepEqual(yield* appliedIds(reopened.sql), []);
          assert.deepEqual(yield* tableNames(reopened.sql), ["effect_sql_migrations"]);
        }),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* boot(plugins(statement("CREATE TABLE more_rows (v TEXT)")));
          assert.deepEqual([...host.activeIds], ["fine", "bad", "child"]);
          assert.deepEqual(yield* appliedIds(database(host, "bad")), [1, 2]);
        }),
      );
    }).pipe(Effect.provide(layerConfig)),
  );

  it.effect("leaves a disabled plugin's file untouched", () =>
    Effect.gen(function* () {
      const plugins = [
        {
          id: "a",
          dependsOn: [],
          migrations: [[1, "init", statement("CREATE TABLE a_rows (v TEXT)")]],
        },
      ] as const;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const filename = path.join(stateDir, "plugins", "a.sqlite");

      yield* Effect.scoped(Effect.asVoid(boot(plugins)));
      const before = yield* fs.readFile(filename);
      yield* fs.writeFileString(path.join(stateDir, "plugins.json"), '{ "a": false }');
      yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* boot(plugins);
          assert.deepEqual([...host.activeIds], []);
        }),
      );
      assert.deepEqual(yield* fs.readFile(filename), before);
    }).pipe(Effect.provide(layerConfig)),
  );

  it.effect("applies a migration once", () =>
    Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(stateDir, "plugins"), { recursive: true });
      const options = {
        id: "once",
        filename: path.join(stateDir, "plugins", "once.sqlite"),
        migrations: [[1, "init", statement("CREATE TABLE once_rows (v TEXT)")]] as const,
      };
      const first = yield* Effect.scoped(
        Effect.map(PluginDatabase.open(options), (opened) => opened.executed),
      );
      const second = yield* Effect.scoped(
        Effect.map(PluginDatabase.open(options), (opened) => opened.executed),
      );
      assert.deepEqual(first, [[1, "init"]]);
      assert.deepEqual(second, []);
    }).pipe(Effect.provide(layerConfig)),
  );
});
