import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

/**
 * Every active plugin's services, once all of them are built. A fiber a plugin's layer forks, such
 * as its reactor's, keeps the context that layer was built in, which holds no sibling plugin's
 * services; `provide` runs an effect there with them, as a sweep or a request fiber has them.
 */
export class PluginServices extends Context.Service<
  PluginServices,
  Deferred.Deferred<Context.Context<never>>
>()("t3/plugins/PluginServices") {}

/** For the host: empty until `fill` is built. */
export const layer = Layer.effect(PluginServices, Deferred.make<Context.Context<never>>());

/** For the host, built over every active plugin's layer: completes `PluginServices` with them. */
export const fill = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Deferred.succeed(yield* PluginServices, yield* Effect.context<never>());
  }),
);

/**
 * Runs `effect` with every active plugin's services under its own, so it can read a sibling's with
 * `Effect.serviceOption`, once they are built. Without the host, as in a plugin's own tests, it
 * runs `effect` as it is.
 */
export const provide = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.flatMap(
    Effect.serviceOption(PluginServices),
    Option.match({
      onNone: () => effect,
      onSome: (built) =>
        Effect.flatMap(Deferred.await(built), (all) =>
          Effect.updateContext(effect, (own: Context.Context<R>) => Context.merge(all, own)),
        ),
    }),
  );
