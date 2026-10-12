import { assert, describe, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type Project,
  type RoutingEntry,
  type RoutingTier,
  type RoutingTiers,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as PluginDatabase from "../PluginDatabase.ts";
import { migrations } from "./migrations.ts";
import * as TierMapService from "./TierMapService.ts";

const alpha = ProviderInstanceId.make("alpha");
const beta = ProviderInstanceId.make("beta");
const entry = (providerInstanceId: ProviderInstanceId, model: string): RoutingEntry => ({
  providerInstanceId,
  model,
});

const provider = (
  instanceId: ProviderInstanceId,
  slugs: ReadonlyArray<string>,
): ServerProvider => ({
  driver: ProviderDriverKind.make("codex"),
  instanceId,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  checkedAt: "2026-10-01T00:00:00.000Z",
  auth: { status: "authenticated" },
  models: slugs.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
  skills: [],
  slashCommands: [],
});
const providers = [provider(alpha, ["a-1", "a-2", "a-3"]), provider(beta, ["b-1", "b-2"])];

const known = ProjectId.make("project-1");
const other = ProjectId.make("project-2");
const project = (id: ProjectId, defaultModelSelection: Project["defaultModelSelection"]) =>
  ({
    id,
    title: id,
    workspaceRoot: "/unused",
    defaultModelSelection,
    scripts: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    deletedAt: null,
  }) satisfies Project;
const projects = [project(known, null), project(other, { instanceId: alpha, model: "a-2" })];

/** One boot of the service on an empty in-memory plugin database. */
const start = (settings: Parameters<typeof ServerSettings.layerTest>[0] = {}) =>
  Effect.gen(function* () {
    const catalog = yield* Ref.make(providers);
    const services = yield* Layer.build(
      TierMapService.layer.pipe(
        Layer.provideMerge(
          Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Ref.get(catalog) }),
        ),
        Layer.provideMerge(ServerSettings.layerTest(settings)),
        Layer.provideMerge(
          Layer.mock(ProjectService.ProjectService)({
            getById: (id) =>
              Effect.succeed(
                Option.fromNullishOr(projects.find((candidate) => candidate.id === id)),
              ),
          }),
        ),
        Layer.provideMerge(
          Layer.effect(
            SqlClient.SqlClient,
            Effect.map(
              PluginDatabase.open({ id: "routing", filename: ":memory:", migrations }),
              (opened) => opened.sql,
            ),
          ),
        ),
      ),
    );
    return {
      catalog,
      tiers: Context.get(services, TierMapService.TierMapService),
      sql: Context.get(services, SqlClient.SqlClient),
    };
  });

const rowCount = (sql: SqlClient.SqlClient) =>
  Effect.map(sql<{ readonly n: number }>`SELECT count(*) AS n FROM tier_map`, (rows) => rows[0]?.n);

const sourcesOf = (tiers: RoutingTiers) =>
  (["cheap", "standard", "strong"] as const).map((tier: RoutingTier) => tiers[tier].source);

describe("TierMapService", () => {
  it.effect("each tier reports where it came from", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { tiers, sql } = yield* start();
        yield* tiers.set({ scope: "environment", tier: "cheap", entry: entry(beta, "b-2") });
        yield* tiers.set({ scope: "environment", tier: "standard", entry: entry(beta, "b-1") });
        const result = yield* tiers.set({
          scope: known,
          tier: "standard",
          entry: entry(alpha, "a-2"),
        });

        assert.deepEqual(sourcesOf(result), ["environment", "project", "builtin"]);
        assert.deepEqual(result.cheap.resolved, entry(beta, "b-2"));
        assert.deepEqual(result.standard.resolved, entry(alpha, "a-2"));
        assert.deepEqual(result.standard.environment, entry(beta, "b-1"));
        assert.deepEqual(result.standard.project, entry(alpha, "a-2"));
        assert.deepEqual(result.strong.resolved, entry(alpha, "a-1"));

        const withoutProject = yield* tiers.get({});
        assert.deepEqual(sourcesOf(withoutProject), ["environment", "environment", "builtin"]);
        assert.isNull(withoutProject.standard.project);

        const rows = yield* sql<{ readonly updated_at: string }>`SELECT updated_at FROM tier_map`;
        assert.lengthOf(rows, 3);
        for (const row of rows) assert.match(row.updated_at, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
      }),
    ),
  );

  it.effect("saving a tier again replaces its entry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { tiers, sql } = yield* start();
        yield* tiers.set({ scope: "environment", tier: "cheap", entry: entry(alpha, "a-1") });
        const result = yield* tiers.set({
          scope: "environment",
          tier: "cheap",
          entry: entry(beta, "b-2"),
        });
        assert.deepEqual(result.cheap.environment, entry(beta, "b-2"));
        assert.strictEqual(yield* rowCount(sql), 1);
      }),
    ),
  );

  it.effect(
    "the built-in takes the project's default model's instance, else the environment's, else the first listed",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const withDefault = yield* start({
            defaultModelSelection: { instanceId: beta, model: "b-2" },
          });
          const strong = (projectId?: ProjectId) =>
            Effect.map(
              withDefault.tiers.get(projectId === undefined ? {} : { projectId }),
              (result) => result.strong.resolved,
            );
          assert.deepEqual(yield* strong(other), entry(alpha, "a-1"));
          assert.deepEqual(yield* strong(known), entry(beta, "b-1"));
          assert.deepEqual(yield* strong(), entry(beta, "b-1"));

          const bare = yield* start();
          assert.deepEqual((yield* bare.tiers.get({})).strong.resolved, entry(alpha, "a-1"));
        }),
      ),
  );

  it.effect(
    "refuses what the catalog does not offer, with the exact message, and saves nothing",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { tiers, sql } = yield* start({
            providerModelPreferences: { [alpha]: { hiddenModels: ["a-3"], modelOrder: [] } },
          });
          const refusal = (input: Parameters<typeof tiers.set>[0]) =>
            Effect.map(Effect.flip(tiers.set(input)), (error) => error.message);

          assert.strictEqual(
            yield* refusal({
              scope: "environment",
              tier: "cheap",
              entry: entry(ProviderInstanceId.make("nope"), "a-1"),
            }),
            'Provider instance "nope" is not configured.',
          );
          assert.strictEqual(
            yield* refusal({ scope: "environment", tier: "cheap", entry: entry(alpha, "b-1") }),
            'Model "b-1" is not offered by provider instance "alpha".',
          );
          assert.strictEqual(
            yield* refusal({ scope: "environment", tier: "cheap", entry: entry(alpha, "a-3") }),
            'Model "a-3" is not offered by provider instance "alpha".',
          );
          assert.strictEqual(
            yield* refusal({
              scope: ProjectId.make("missing"),
              tier: "cheap",
              entry: entry(alpha, "a-1"),
            }),
            'Project "missing" was not found.',
          );
          assert.strictEqual(yield* rowCount(sql), 0);
        }),
      ),
  );

  it.effect("clearing an entry restores the next source", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { tiers, sql } = yield* start();
        yield* tiers.set({ scope: "environment", tier: "strong", entry: entry(beta, "b-2") });
        const set = yield* tiers.set({ scope: known, tier: "strong", entry: entry(alpha, "a-2") });
        assert.strictEqual(set.strong.source, "project");

        const cleared = yield* tiers.set({ scope: known, tier: "strong", entry: null });
        assert.strictEqual(cleared.strong.source, "environment");
        assert.deepEqual(cleared.strong.resolved, entry(beta, "b-2"));
        assert.isNull(cleared.strong.project);

        const builtin = yield* tiers.set({ scope: "environment", tier: "strong", entry: null });
        assert.strictEqual(builtin.strong.source, "builtin");
        assert.strictEqual(yield* rowCount(sql), 0);
      }),
    ),
  );

  it.effect("a saved model that leaves the catalog stays saved and reports unavailable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { tiers, sql, catalog } = yield* start();
        yield* tiers.set({ scope: "environment", tier: "cheap", entry: entry(alpha, "a-3") });
        yield* Ref.set(catalog, [provider(alpha, ["a-1"]), providers[1]!]);

        const result = yield* tiers.get({});
        assert.deepEqual(result.cheap.resolved, entry(alpha, "a-3"));
        assert.strictEqual(result.cheap.source, "environment");
        assert.isFalse(result.cheap.available);
        assert.isTrue(result.strong.available);
        assert.strictEqual(yield* rowCount(sql), 1);
      }),
    ),
  );
});
