import * as Schema from "effect/Schema";
import { ProjectId, TrimmedNonEmptyString } from "../baseSchemas.ts";
import { ProviderInstanceId } from "../providerInstance.ts";
import { definePluginMethods } from "./method.ts";

/** How much model a task needs. */
export const RoutingTier = Schema.Literals(["cheap", "standard", "strong"]);
export type RoutingTier = typeof RoutingTier.Type;
export const ROUTING_TIERS = RoutingTier.literals;

/** A provider instance and one of its models, the model id as the catalog lists it. */
export const RoutingEntry = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
});
export type RoutingEntry = typeof RoutingEntry.Type;

/** Where a resolved entry came from. */
export const RoutingSource = Schema.Literals(["project", "environment", "builtin"]);
export type RoutingSource = typeof RoutingSource.Type;

/** `environment`, or the id of the project the entry belongs to. */
export const RoutingScope = Schema.Union([Schema.Literal("environment"), ProjectId]);
export type RoutingScope = typeof RoutingScope.Type;

export const RoutingTierState = Schema.Struct({
  /** Null with `source` when no provider instance lists a model, so nothing can be picked. */
  resolved: Schema.NullOr(RoutingEntry),
  source: Schema.NullOr(RoutingSource),
  /** Whether the catalog still offers `resolved`. A saved entry stays saved when it does not. */
  available: Schema.Boolean,
  environment: Schema.NullOr(RoutingEntry),
  /** Always null without a project. */
  project: Schema.NullOr(RoutingEntry),
});
export type RoutingTierState = typeof RoutingTierState.Type;

export const RoutingTiers = Schema.Struct({
  cheap: RoutingTierState,
  standard: RoutingTierState,
  strong: RoutingTierState,
});
export type RoutingTiers = typeof RoutingTiers.Type;

export const RoutingTiersGetInput = Schema.Struct({ projectId: Schema.optional(ProjectId) });
export type RoutingTiersGetInput = typeof RoutingTiersGetInput.Type;

export const RoutingTiersSetInput = Schema.Struct({
  scope: RoutingScope,
  tier: RoutingTier,
  /** Null deletes the saved entry, so the tier falls back to the next source. */
  entry: Schema.NullOr(RoutingEntry),
});
export type RoutingTiersSetInput = typeof RoutingTiersSetInput.Type;

export class RoutingError extends Schema.TaggedError<RoutingError>()("RoutingError", {
  code: Schema.Literals(["inactive", "invalid", "not_found", "io"]),
  message: Schema.String,
}) {}

export const ROUTING_METHODS = definePluginMethods({
  tiersGet: {
    method: "routing.tiers.get",
    gateway: "read",
    input: RoutingTiersGetInput,
    output: RoutingTiers,
    error: RoutingError,
  },
  tiersSet: {
    method: "routing.tiers.set",
    gateway: "settingsWrite",
    input: RoutingTiersSetInput,
    output: RoutingTiers,
    error: RoutingError,
  },
});
