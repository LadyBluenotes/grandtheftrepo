import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  KANBAN_METHODS,
  PLUGIN_GATEWAY_WS_METHODS,
  PluginMethodError,
  ProjectId,
  definePluginMethods,
  type AuthSessionState,
  type KanbanWriteInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { vi } from "vite-plus/test";

import { AVAILABLE_CONNECTION_STATE } from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { executeAtomQuery } from "../state/runtime.ts";
import { createPluginRpcCommand, createPluginRpcQueryAtomFamily } from "./rpc.ts";

vi.mock("../state/session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);
const env = EnvironmentId.make("target");

class NoteError extends Schema.TaggedError<NoteError>()("NoteError", {
  message: Schema.String,
}) {}
const isNoteError = Schema.is(NoteError);

/** A read whose input and output differ on the wire, so the helper must encode and decode them. */
const DOUBLE = definePluginMethods({
  double: {
    method: "notes.double",
    gateway: "read",
    input: Schema.Struct({ n: Schema.NumberFromString }),
    output: Schema.Struct({ doubled: Schema.NumberFromString }),
    error: NoteError,
  },
}).double;

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

it("sends the encoded input and gives a plugin's failure back its own type", async () => {
  const sent: Array<unknown> = [];
  const runtime = connectedRuntime({
    [PLUGIN_GATEWAY_WS_METHODS.operate]: (call) => {
      sent.push(call);
      return Effect.fail(
        new PluginMethodError({
          method: KANBAN_METHODS.write.method,
          error: { _tag: "KanbanError", code: "gated", message: "Needs a review first." },
        }),
      );
    },
  });
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

it("reads through plugins.read with the method's own input, output and failure types", async () => {
  const sent: Array<unknown> = [];
  const runtime = connectedRuntime({
    [PLUGIN_GATEWAY_WS_METHODS.read]: (call) => {
      sent.push(call);
      const { n } = (call as { readonly input: { readonly n: string } }).input;
      return n === "0"
        ? Effect.fail(
            new PluginMethodError({
              method: DOUBLE.method,
              error: { _tag: "NoteError", message: "Zero has no double." },
            }),
          )
        : Effect.succeed({ doubled: String(Number(n) * 2) });
    },
  });
  const triggeredBy: Array<unknown> = [];
  const signal = Atom.make(0);
  const double = createPluginRpcQueryAtomFamily(runtime, {
    label: "test.notes.double",
    method: DOUBLE,
    refreshTrigger: (target) => {
      triggeredBy.push(target.input);
      return signal;
    },
  });
  const registry = AtomRegistry.make();
  try {
    const target = { environmentId: env, input: { n: 21 } };
    expect(double(target)).toBe(double({ environmentId: env, input: { n: 21 } }));
    const answered = await executeAtomQuery(registry, double(target), { reportFailure: false });
    if (answered._tag !== "Success") throw new Error("expected a success");
    expect(answered.value).toEqual({ doubled: 42 });
    expect(sent).toEqual([{ method: "notes.double", input: { n: "21" } }]);
    // The family is keyed by the encoded input; the trigger sees it decoded again.
    expect(triggeredBy).toEqual([{ n: 21 }]);

    const refused = await executeAtomQuery(
      registry,
      double({ environmentId: env, input: { n: 0 } }),
      {
        reportFailure: false,
      },
    );
    if (refused._tag !== "Failure") throw new Error("expected a failure");
    const error = Option.getOrThrow(Cause.findErrorOption(refused.cause));
    if (!isNoteError(error)) throw new Error(`expected NoteError, got ${String(error)}`);
    expect(error.message).toBe("Zero has no double.");
  } finally {
    registry.dispose();
  }
});
