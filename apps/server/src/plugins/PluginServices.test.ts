import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as PluginHost from "./PluginHost.ts";
import * as PluginServices from "./PluginServices.ts";

class Probe extends Context.Service<Probe, { readonly id: string }>()(
  "t3/plugins/PluginServices.test/Probe",
) {}

interface Seen {
  readonly own: Option.Option<Probe["Service"]>;
  readonly provided: Option.Option<Probe["Service"]>;
}

/**
 * Two plugins on the real host: `reader`'s layer forks a fiber, as a reactor is forked, that hands
 * `seen` what `Effect.serviceOption(Probe)` finds in its own context and through
 * `PluginServices.provide`; `probe` provides `Probe`. Neither depends on the other.
 */
const layerProbeHost = (seen: Deferred.Deferred<Seen>) =>
  PluginHost.layerOf([
    {
      id: "reader",
      dependsOn: [],
      layer: Layer.effectDiscard(
        ServerActivation.forkParked(
          Effect.gen(function* () {
            const own = yield* Effect.serviceOption(Probe);
            const provided = yield* PluginServices.provide(Effect.serviceOption(Probe));
            yield* Deferred.succeed(seen, { own, provided });
          }),
        ),
      ),
    },
    { id: "probe", dependsOn: [], layer: Layer.succeed(Probe, { id: "probe" }) },
  ]).pipe(
    Layer.provide(
      Layer.mergeAll(
        SqlitePersistence.layerMemory,
        // The test plugins need none of these; the registry's requirements still type through.
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(ProviderRegistry.ProviderRegistry)({}),
        ServerSettings.layerTest(),
      ),
    ),
  );

it.layer(NodeServices.layer)("plugin services", (it) => {
  it.effect(
    "a fiber a plugin forked reads a sibling's service through them, and none when it is off",
    () =>
      Effect.gen(function* () {
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const seenWith = (probeEnabled: boolean) =>
          Effect.gen(function* () {
            yield* fs.writeFileString(
              path.join(stateDir, "plugins.json"),
              `{ "probe": ${probeEnabled} }`,
            );
            const activation = yield* Deferred.make<void>();
            const seen = yield* Deferred.make<Seen>();
            return yield* Effect.gen(function* () {
              yield* Deferred.succeed(activation, undefined);
              return yield* Deferred.await(seen);
            }).pipe(
              Effect.provide(layerProbeHost(seen)),
              Effect.provideService(ServerActivation.ServerActivation, Deferred.await(activation)),
            );
          });

        const on = yield* seenWith(true);
        assert.isTrue(Option.isNone(on.own));
        assert.strictEqual(Option.getOrUndefined(on.provided)?.id, "probe");
        const off = yield* seenWith(false);
        assert.isTrue(Option.isNone(off.provided));
      }).pipe(
        Effect.provide(
          Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-plugin-services-" })),
        ),
      ),
  );
});
