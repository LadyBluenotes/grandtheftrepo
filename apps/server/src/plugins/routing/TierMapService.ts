import {
  RoutingEntry,
  RoutingError,
  RoutingTier,
  type ProjectId,
  type ProviderInstanceId,
  type RoutingTiers,
  type RoutingTiersGetInput,
  type RoutingTiersSetInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { resolveTiers, type SavedEntries } from "./TierMap.ts";

export class TierMapService extends Context.Service<
  TierMapService,
  {
    /** Each tier resolved for the environment, or for `projectId` when given. */
    readonly get: (input: RoutingTiersGetInput) => Effect.Effect<RoutingTiers, RoutingError>;
    /** Saves or, with a null entry, deletes one tier's entry at one scope; returns `get`'s result. */
    readonly set: (input: RoutingTiersSetInput) => Effect.Effect<RoutingTiers, RoutingError>;
  }
>()("t3/plugins/routing/TierMapService") {}

/**
 * For code outside the plugin's layer, such as a WebSocket handler: the service when the plugin
 * runs, else the plugin's own error. Plugin services are typed as absent from the server chain.
 */
export const fromOption = Option.match({
  onNone: () => new RoutingError({ code: "inactive", message: 'Plugin "routing" is not running.' }),
  onSome: Effect.succeed<TierMapService["Service"]>,
});

const SavedRow = Schema.Struct({ tier: RoutingTier, ...RoutingEntry.fields });

const refuse = (message: string) => new RoutingError({ code: "invalid", message });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const settings = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;

  const io = (message: string) => (cause: unknown) =>
    Effect.logWarning(message, { cause }).pipe(
      Effect.andThen(Effect.fail(new RoutingError({ code: "io", message }))),
    );

  const project = (projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      Effect.catch(io("Could not read the project.")),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            new RoutingError({
              code: "not_found",
              message: `Project "${projectId}" was not found.`,
            }),
          onSome: Effect.succeed,
        }),
      ),
    );

  /** The catalog `orchestrator_capabilities` reports: models the user hid from pickers stay out. */
  const catalog = Effect.gen(function* () {
    const current = yield* settings.getSettings.pipe(
      Effect.catch(io("Could not read the server settings.")),
    );
    const hidden = current.providerModelPreferences ?? {};
    const offers = (yield* providers.getProviders).map((provider) => ({
      providerInstanceId: provider.instanceId,
      models: provider.models
        .filter(
          (model) =>
            model.isCustom || !hidden[provider.instanceId]?.hiddenModels.includes(model.slug),
        )
        .map((model) => model.slug),
    }));
    return { current, offers };
  });

  const savedRows = SqlSchema.findAll({
    Request: Schema.String,
    Result: SavedRow,
    execute: (scope) =>
      sql`
        SELECT tier AS "tier", provider_instance_id AS "providerInstanceId", model AS "model"
        FROM tier_map
        WHERE scope = ${scope}
      `,
  });
  const saved = (scope: string): Effect.Effect<SavedEntries, RoutingError> =>
    savedRows(scope).pipe(
      Effect.map((rows) =>
        Object.fromEntries(
          rows.map(({ tier, providerInstanceId, model }) => [tier, { providerInstanceId, model }]),
        ),
      ),
      Effect.catch(io("Could not read the tier map.")),
    );

  const get = Effect.fn("TierMapService.get")(function* ({ projectId }: RoutingTiersGetInput) {
    const found = projectId === undefined ? undefined : yield* project(projectId);
    const { current, offers } = yield* catalog;
    const preferred: Array<ProviderInstanceId> = [];
    for (const selection of [found?.defaultModelSelection, current.defaultModelSelection]) {
      if (selection) preferred.push(selection.instanceId);
    }
    return resolveTiers({
      catalog: offers,
      preferred,
      environment: yield* saved("environment"),
      project: projectId === undefined ? {} : yield* saved(projectId),
    });
  });

  const set = Effect.fn("TierMapService.set")(function* ({
    scope,
    tier,
    entry,
  }: RoutingTiersSetInput) {
    if (scope !== "environment") yield* project(scope);
    if (entry === null) {
      yield* sql`DELETE FROM tier_map WHERE scope = ${scope} AND tier = ${tier}`.pipe(
        Effect.catch(io("Could not save the tier map.")),
      );
    } else {
      const offer = (yield* catalog).offers.find(
        (candidate) => candidate.providerInstanceId === entry.providerInstanceId,
      );
      if (offer === undefined) {
        return yield* refuse(`Provider instance "${entry.providerInstanceId}" is not configured.`);
      }
      if (!offer.models.includes(entry.model)) {
        return yield* refuse(
          `Model "${entry.model}" is not offered by provider instance "${entry.providerInstanceId}".`,
        );
      }
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO tier_map (scope, tier, provider_instance_id, model, updated_at)
        VALUES (${scope}, ${tier}, ${entry.providerInstanceId}, ${entry.model}, ${updatedAt})
        ON CONFLICT (scope, tier) DO UPDATE SET
          provider_instance_id = excluded.provider_instance_id,
          model = excluded.model,
          updated_at = excluded.updated_at
      `.pipe(Effect.catch(io("Could not save the tier map.")));
    }
    return yield* get(scope === "environment" ? {} : { projectId: scope });
  });

  return TierMapService.of({ get, set });
});

export const layer = Layer.effect(TierMapService, make);
