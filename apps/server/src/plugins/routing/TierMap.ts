import type {
  ProviderInstanceId,
  RoutingEntry,
  RoutingTier,
  RoutingTierState,
  RoutingTiers,
} from "@t3tools/contracts";

/** The models each provider instance offers, in the order the catalog lists them. */
export type Catalog = ReadonlyArray<{
  readonly providerInstanceId: ProviderInstanceId;
  readonly models: ReadonlyArray<string>;
}>;

export type SavedEntries = Partial<Record<RoutingTier, RoutingEntry>>;

/**
 * One instance fills every tier: the first of `preferred`, else the first the catalog lists, that
 * offers any model. The catalog has no size field, so this assumes it lists the strongest first:
 * that one is `strong`, the last is `cheap`, and `standard` is the middle (the earlier, when even).
 */
const builtinTiers = (
  catalog: Catalog,
  preferred: ReadonlyArray<ProviderInstanceId>,
): Record<RoutingTier, RoutingEntry> | null => {
  const instance = [...preferred, ...catalog.map((offer) => offer.providerInstanceId)]
    .map((id) => catalog.find((offer) => offer.providerInstanceId === id))
    .find((offer) => offer !== undefined && offer.models.length > 0);
  if (instance === undefined) return null;
  const pick = (index: number) => ({
    providerInstanceId: instance.providerInstanceId,
    model: instance.models[index]!,
  });
  return {
    strong: pick(0),
    standard: pick(Math.floor((instance.models.length - 1) / 2)),
    cheap: pick(instance.models.length - 1),
  };
};

/**
 * Each tier resolves on its own: the project's entry, else the environment's, else the built-in.
 * `preferred` names the instances the built-in tries first: the project's default model's, then
 * the environment's.
 */
export const resolveTiers = (input: {
  readonly catalog: Catalog;
  readonly preferred: ReadonlyArray<ProviderInstanceId>;
  readonly environment: SavedEntries;
  readonly project: SavedEntries;
}): RoutingTiers => {
  const builtin = builtinTiers(input.catalog, input.preferred);
  const offered = (entry: RoutingEntry) =>
    input.catalog.some(
      (offer) =>
        offer.providerInstanceId === entry.providerInstanceId && offer.models.includes(entry.model),
    );
  const tier = (name: RoutingTier): RoutingTierState => {
    const project = input.project[name] ?? null;
    const environment = input.environment[name] ?? null;
    const resolved = project ?? environment ?? builtin?.[name] ?? null;
    return {
      resolved,
      source:
        project !== null
          ? "project"
          : environment !== null
            ? "environment"
            : resolved !== null
              ? "builtin"
              : null,
      available: resolved !== null && offered(resolved),
      environment,
      project,
    };
  };
  return { cheap: tier("cheap"), standard: tier("standard"), strong: tier("strong") };
};
