import { expect, it } from "@effect/vitest";
import { EnvironmentId, PLUGIN_GATEWAY_WS_METHODS, type PluginStatus } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";

import { AVAILABLE_CONNECTION_STATE } from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createKanbanActiveAtomFamily } from "./kanban.ts";

const env = EnvironmentId.make("target");

/** What a server that predates the plugin gateway answers to `plugins.read`. */
class UnknownRpcError extends Schema.TaggedError<UnknownRpcError>()("UnknownRpcError", {
  message: Schema.String,
}) {}

const status = (id: string, active: boolean): PluginStatus => ({
  id,
  dependsOn: [],
  enabled: active,
  active,
  missing: [],
  startError: null,
});

/** An atom runtime connected to `env`, whose session answers with `client`. */
const connectedRuntime = (client: Record<string, (call: unknown) => unknown>) =>
  Atom.runtime(
    Layer.effect(
      EnvironmentRegistry,
      Effect.gen(function* () {
        const supervisor = {
          target: { environmentId: env, label: "target" },
          state: yield* SubscriptionRef.make({
            ...AVAILABLE_CONNECTION_STATE,
            desired: true,
            network: "online",
            phase: "connected",
          }),
          session: yield* SubscriptionRef.make(Option.some({ client } as unknown as RpcSession)),
        } as unknown as EnvironmentSupervisor["Service"];
        return {
          run: <A, E>(_id: EnvironmentId, effect: Effect.Effect<A, E, EnvironmentSupervisor>) =>
            Effect.provideService(effect, EnvironmentSupervisor, supervisor),
          followStream: <A, E>(
            _id: EnvironmentId,
            stream: Stream.Stream<A, E, EnvironmentSupervisor>,
          ) => Stream.provideService(stream, EnvironmentSupervisor, supervisor),
        } as unknown as EnvironmentRegistry["Service"];
      }),
    ),
  );

/** The first answer the atom gives once it is no longer unknown. */
const answer = (registry: AtomRegistry.AtomRegistry, atom: Atom.Atom<boolean | null>) =>
  new Promise<boolean>((resolve) => {
    let stop: (() => void) | undefined;
    let settled = false;
    stop = registry.subscribe(
      atom,
      (value) => {
        if (value === null || settled) return;
        settled = true;
        stop?.();
        resolve(value);
      },
      { immediate: true },
    );
    if (settled) stop();
  });

const activeFor = async (read: (call: unknown) => unknown) => {
  const active = createKanbanActiveAtomFamily(
    connectedRuntime({ [PLUGIN_GATEWAY_WS_METHODS.read]: read }),
  );
  const registry = AtomRegistry.make();
  try {
    return await answer(registry, active(env));
  } finally {
    registry.dispose();
  }
};

it("is on only when plugins.list reports kanban active", async () => {
  expect(
    await activeFor(() => Effect.succeed([status("telemetry", true), status("kanban", true)])),
  ).toBe(true);
});

it.each([
  ["is switched off", [status("kanban", false)]],
  ["is not registered", [status("telemetry", true)]],
])("is off when the plugin %s", async (_name, statuses) => {
  expect(await activeFor(() => Effect.succeed(statuses))).toBe(false);
});

it("is off on a server that does not have the plugin RPCs", async () => {
  expect(
    await activeFor(() =>
      Effect.fail(new UnknownRpcError({ message: "Unknown request tag: plugins.read" })),
    ),
  ).toBe(false);
});
