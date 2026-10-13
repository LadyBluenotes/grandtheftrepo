import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type RoutingEntry,
  type RoutingTierState,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as PluginDatabase from "../PluginDatabase.ts";
import { plugin } from "./index.ts";
import { migrations } from "./migrations.ts";
import * as Checks from "./readiness.ts";
import * as TierMapService from "./TierMapService.ts";

const alpha = ProviderInstanceId.make("alpha");
const entry = (model: string): RoutingEntry => ({ providerInstanceId: alpha, model });
const state = (
  source: RoutingTierState["source"],
  model: string,
  available = true,
): RoutingTierState => ({
  resolved: entry(model),
  source,
  available,
  environment: source === "environment" ? entry(model) : null,
  project: source === "project" ? entry(model) : null,
});

describe("tiersCheck", () => {
  it("is ready when every tier is saved and offered", () => {
    const check = Checks.tiersCheck({
      cheap: state("environment", "a-3"),
      standard: state("project", "a-2"),
      strong: state("environment", "a-1"),
    });
    assert.strictEqual(check.status, "ready");
  });

  it("names the tiers that fall back and the ones whose model is gone", () => {
    const check = Checks.tiersCheck({
      cheap: state("builtin", "a-3"),
      standard: state("environment", "gone", false),
      strong: state("builtin", "a-1"),
    });
    assert.strictEqual(check.status, "attention");
    assert.strictEqual(
      check.sentence,
      "Cheap and strong have no saved model, so they fall back to a guess from one provider's list; standard names a model the catalog no longer offers; set them in the Routing panel.",
    );
    assert.strictEqual(check.target, "plugins");
  });
});

const provider: ServerProvider = {
  driver: ProviderDriverKind.make("codex"),
  instanceId: alpha,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  checkedAt: "2026-10-01T00:00:00.000Z",
  auth: { status: "authenticated" },
  models: ["a-1", "a-2", "a-3"].map((slug) => ({
    slug,
    name: slug,
    isCustom: false,
    capabilities: null,
  })),
  skills: [],
  slashCommands: [],
};

it.effect(
  "a fresh environment needs its tiers, and is ready on the next request once they are set",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { sql } = yield* PluginDatabase.open({
          id: "routing",
          filename: ":memory:",
          migrations,
        });
        const services = yield* Layer.build(
          Checks.layer.pipe(
            Layer.provideMerge(TierMapService.layer),
            Layer.provide(
              Layer.mock(ProviderRegistry.ProviderRegistry)({
                getProviders: Effect.succeed([provider]),
              }),
            ),
            Layer.provide(ServerSettings.layerTest()),
            Layer.provide(
              Layer.mock(ProjectService.ProjectService)({
                getById: () => Effect.succeedNone,
              }),
            ),
            Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
          ),
        );
        // The plugin's own hook, which reads its readiness service where the call runs.
        const readiness = plugin.readiness(null).pipe(Effect.provideContext(services));

        const [fresh] = yield* readiness;
        assert.strictEqual(fresh?.status, "attention");
        assert.strictEqual(
          fresh?.sentence,
          "Cheap, standard and strong have no saved model, so they fall back to a guess from one provider's list; set them in the Routing panel.",
        );

        const tiers = yield* TierMapService.TierMapService.pipe(Effect.provideContext(services));
        for (const [tier, model] of [
          ["cheap", "a-3"],
          ["standard", "a-2"],
          ["strong", "a-1"],
        ] as const) {
          yield* tiers.set({ scope: "environment", tier, entry: entry(model) });
        }
        const [set] = yield* readiness;
        assert.strictEqual(set?.status, "ready");
      }),
    ),
);
