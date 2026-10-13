import { HOST_METHODS, KANBAN_WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import type * as EnvironmentRegistry from "../connection/registry.ts";
import { createEnvironmentRpcSubscriptionAtomFamily } from "../state/runtime.ts";
import { createPluginRpcQueryAtomFamily } from "./rpc.ts";

/**
 * Live board of one project: a snapshot on subscribe and a fresh one after every change on disk or
 * in the app, so a client that holds it open never needs to poll. Refreshing the atom resubscribes.
 */
export function createKanbanBoardAtomFamily<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
) {
  return createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:kanban:board",
    tag: KANBAN_WS_METHODS.subscribe,
  });
}

/**
 * Whether `environmentId` runs the kanban plugin; null while unknown. A server without the plugin
 * RPCs (upstream T3 Code) fails the call, which counts as off.
 */
export function createKanbanActiveAtomFamily<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
) {
  const pluginStatuses = createPluginRpcQueryAtomFamily(runtime, {
    label: "environment-data:plugins",
    method: HOST_METHODS.list,
    staleTimeMs: 60_000,
  });
  return Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): boolean | null => {
      const result = get(pluginStatuses({ environmentId, input: {} }));
      if (result._tag === "Failure") return false;
      return Option.match(AsyncResult.value(result), {
        onNone: () => null,
        onSome: (statuses) => statuses.some((status) => status.id === "kanban" && status.active),
      });
    }).pipe(Atom.withLabel(`environment-data:kanban:active:${environmentId}`)),
  );
}
