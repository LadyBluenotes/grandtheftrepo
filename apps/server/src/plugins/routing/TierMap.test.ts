import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, type RoutingEntry, type RoutingTier } from "@t3tools/contracts";

import { resolveTiers, type Catalog } from "./TierMap.ts";

const alpha = ProviderInstanceId.make("alpha");
const beta = ProviderInstanceId.make("beta");
const entry = (providerInstanceId: ProviderInstanceId, model: string): RoutingEntry => ({
  providerInstanceId,
  model,
});
const models = (providerInstanceId: ProviderInstanceId, count: number) => ({
  providerInstanceId,
  models: Array.from({ length: count }, (_, index) => `${providerInstanceId}-${index + 1}`),
});
const resolve = (
  catalog: Catalog,
  overrides: {
    readonly preferred?: ReadonlyArray<ProviderInstanceId>;
    readonly environment?: Partial<Record<RoutingTier, RoutingEntry>>;
    readonly project?: Partial<Record<RoutingTier, RoutingEntry>>;
  } = {},
) =>
  resolveTiers({
    catalog,
    preferred: overrides.preferred ?? [],
    environment: overrides.environment ?? {},
    project: overrides.project ?? {},
  });
const builtins = (catalog: Catalog) => {
  const tiers = resolve(catalog);
  return [tiers.strong, tiers.standard, tiers.cheap].map((tier) => tier.resolved?.model);
};

describe("built-in tiers", () => {
  it("one model fills every tier", () => {
    assert.deepEqual(builtins([models(alpha, 1)]), ["alpha-1", "alpha-1", "alpha-1"]);
  });

  it("two models: strongest first, cheapest last, standard the earlier middle", () => {
    assert.deepEqual(builtins([models(alpha, 2)]), ["alpha-1", "alpha-1", "alpha-2"]);
  });

  it("three models", () => {
    assert.deepEqual(builtins([models(alpha, 3)]), ["alpha-1", "alpha-2", "alpha-3"]);
  });

  it("four models: standard is the second", () => {
    assert.deepEqual(builtins([models(alpha, 4)]), ["alpha-1", "alpha-2", "alpha-4"]);
  });

  it("uses one instance: the preferred one, else the first the catalog lists", () => {
    const catalog = [models(alpha, 2), models(beta, 3)];
    assert.deepEqual(
      [resolve(catalog).strong.resolved?.providerInstanceId],
      [alpha],
      "first listed",
    );
    const preferred = resolve(catalog, { preferred: [beta, alpha] });
    assert.deepEqual(
      [preferred.strong, preferred.standard, preferred.cheap].map((tier) => tier.resolved),
      [entry(beta, "beta-1"), entry(beta, "beta-2"), entry(beta, "beta-3")],
    );
    assert.strictEqual(preferred.cheap.source, "builtin");
    assert.isTrue(preferred.cheap.available);
  });

  it("skips an instance that offers no model", () => {
    const empty = { providerInstanceId: alpha, models: [] };
    assert.strictEqual(resolve([empty, models(beta, 1)]).cheap.resolved?.model, "beta-1");
    assert.strictEqual(resolve([empty], { preferred: [alpha] }).cheap.resolved, null);
  });

  it("resolves nothing without a catalog", () => {
    assert.deepEqual(resolve([]).strong, {
      resolved: null,
      source: null,
      available: false,
      environment: null,
      project: null,
    });
  });
});

describe("sources", () => {
  const catalog = [models(alpha, 3), models(beta, 3)];

  it("each tier takes the project entry, else the environment's, else the built-in", () => {
    const tiers = resolve(catalog, {
      environment: { cheap: entry(beta, "beta-3"), standard: entry(beta, "beta-2") },
      project: { cheap: entry(alpha, "alpha-2") },
    });
    assert.deepEqual(
      [tiers.cheap, tiers.standard, tiers.strong].map((tier) => [tier.source, tier.resolved]),
      [
        ["project", entry(alpha, "alpha-2")],
        ["environment", entry(beta, "beta-2")],
        ["builtin", entry(alpha, "alpha-1")],
      ],
    );
    assert.deepEqual(tiers.cheap.environment, entry(beta, "beta-3"));
    assert.deepEqual(tiers.cheap.project, entry(alpha, "alpha-2"));
    assert.isNull(tiers.standard.project);
  });

  it("a saved model the catalog dropped still resolves, as unavailable", () => {
    const tiers = resolve(catalog, {
      environment: {
        strong: entry(alpha, "gone"),
        standard: entry(ProviderInstanceId.make("old"), "x"),
      },
    });
    assert.deepEqual(tiers.strong.resolved, entry(alpha, "gone"));
    assert.isFalse(tiers.strong.available);
    assert.isFalse(tiers.standard.available);
    assert.isTrue(tiers.cheap.available);
  });
});
