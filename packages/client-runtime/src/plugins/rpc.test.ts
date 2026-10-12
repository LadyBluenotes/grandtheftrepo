import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  KANBAN_METHODS,
  PLUGIN_GATEWAY_WS_METHODS,
  PluginMethodError,
  ProjectId,
  type AuthSessionState,
  type KanbanWriteInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { vi } from "vite-plus/test";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createPluginRpcCommand } from "./rpc.ts";

vi.mock("../state/session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);
const env = EnvironmentId.make("target");

it("sends the encoded input and gives a plugin's failure back its own type", async () => {
  const sent: Array<unknown> = [];
  const session = {
    client: {
      [PLUGIN_GATEWAY_WS_METHODS.operate]: (call: unknown) => {
        sent.push(call);
        return Effect.fail(
          new PluginMethodError({
            method: KANBAN_METHODS.write.method,
            error: { _tag: "KanbanError", code: "gated", message: "Needs a review first." },
          }),
        );
      },
    },
  } as unknown as RpcSession;
  const runtime = Atom.runtime(
    Layer.effect(
      EnvironmentRegistry,
      Effect.gen(function* () {
        const supervisor = {
          target: { environmentId: env, label: "target" },
          session: yield* SubscriptionRef.make(Option.some(session)),
        } as unknown as EnvironmentSupervisor["Service"];
        return {
          run: <A, E>(_id: EnvironmentId, effect: Effect.Effect<A, E, EnvironmentSupervisor>) =>
            Effect.provideService(effect, EnvironmentSupervisor, supervisor),
        } as unknown as EnvironmentRegistry["Service"];
      }),
    ),
  );
  const registry = AtomRegistry.make();
  const unmount = registry.mount(sessions(env));
  registry.set(
    sessions(env),
    AsyncResult.success({
      authenticated: true,
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "test",
      },
      scopes: [AuthOrchestrationOperateScope],
      permissions: [AuthOrchestrationOperateScope],
    }),
  );
  try {
    const write = createPluginRpcCommand(runtime, {
      label: "test.kanban.write",
      method: KANBAN_METHODS.write,
    });
    const input: KanbanWriteInput = {
      projectId: ProjectId.make("project"),
      action: "issue.create",
      title: "Fix it",
    };
    const result = await write.run(registry, { environmentId: env, input });
    expect(sent).toEqual([{ method: "kanban.write", input }]);
    if (result._tag !== "Failure") throw new Error("expected a failure");
    const error = Option.getOrThrow(Cause.findErrorOption(result.cause));
    if (error._tag !== "KanbanError") throw new Error(`expected KanbanError, got ${error._tag}`);
    expect(error.code).toBe("gated");
    expect(error.message).toBe("Needs a review first.");
  } finally {
    unmount();
    registry.dispose();
  }
});
