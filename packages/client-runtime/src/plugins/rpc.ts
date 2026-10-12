import {
  PLUGIN_GATEWAY_WS_METHODS,
  PluginMethodError,
  type EnvironmentId,
  type PluginMethod,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, type Atom, type AtomRegistry } from "effect/reactivity";

import type * as EnvironmentRegistry from "../connection/registry.ts";
import { request } from "../rpc/client.ts";
import { createEnvironmentQueryAtomFamily, createEnvironmentRpcCommand } from "../state/runtime.ts";

const isPluginMethodError = Schema.is(PluginMethodError);

/** A plugin's failure back as its own type; one this client cannot decode stays a `PluginMethodError`. */
const methodFailure = <I, O, F>(method: PluginMethod<I, O, F>) => {
  const decode = method.error === undefined ? undefined : Schema.decodeUnknownOption(method.error);
  return (error: PluginMethodError): F | PluginMethodError =>
    decode === undefined ? error : Option.getOrElse(decode(error.error), () => error);
};

/**
 * A command for one plugin method through its gateway RPC, with that RPC's `permissionAtom`. It
 * takes the method's input, answers with its output and fails with its own error.
 */
export function createPluginRpcCommand<R, ER, I, O, F = never>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  options: { readonly label: string; readonly method: PluginMethod<I, O, F> },
) {
  const { method } = options;
  const command = createEnvironmentRpcCommand(runtime, {
    label: options.label,
    tag: PLUGIN_GATEWAY_WS_METHODS[method.gateway],
  });
  const encodeInput = Schema.encodeSync(method.input);
  const decodeOutput = Schema.decodeUnknownSync(method.output);
  const failure = methodFailure(method);
  return {
    ...command,
    run: async (
      registry: AtomRegistry.AtomRegistry,
      target: { readonly environmentId: EnvironmentId; readonly input: I },
    ) => {
      const result = await command.run(registry, {
        environmentId: target.environmentId,
        input: { method: method.method, input: encodeInput(target.input) },
      });
      return result._tag === "Success"
        ? AsyncResult.success(decodeOutput(result.value))
        : AsyncResult.failure(
            Cause.map(result.cause, (error) =>
              isPluginMethodError(error) ? failure(error) : error,
            ),
          );
    },
  };
}

/**
 * A query family for one `read` plugin method through `plugins.read`. Keyed by the encoded input,
 * which is what crosses the wire and survives the family's JSON key.
 */
export function createPluginRpcQueryAtomFamily<R, ER, I, O, F = never>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  options: {
    readonly label: string;
    readonly method: PluginMethod<I, O, F> & { readonly gateway: "read" };
    readonly staleTimeMs?: number;
    readonly refreshIntervalMs?: number;
    readonly refreshTrigger?: (target: {
      readonly environmentId: EnvironmentId;
      readonly input: I;
    }) => Atom.Atom<unknown> | undefined;
  },
) {
  const { method, refreshTrigger, ...rest } = options;
  const encodeInput = Schema.encodeSync(method.input);
  const decodeInput = Schema.decodeUnknownSync(method.input);
  const decodeOutput = Schema.decodeUnknownEffect(method.output);
  const failure = methodFailure(method);
  const family = createEnvironmentQueryAtomFamily(runtime, {
    ...rest,
    ...(refreshTrigger === undefined
      ? {}
      : {
          refreshTrigger: (target: {
            readonly environmentId: EnvironmentId;
            readonly input: unknown;
          }) => refreshTrigger({ ...target, input: decodeInput(target.input) }),
        }),
    execute: (input: unknown) =>
      request(PLUGIN_GATEWAY_WS_METHODS.read, { method: method.method, input }).pipe(
        Effect.catchTags({ PluginMethodError: (error) => Effect.fail(failure(error)) }),
        Effect.flatMap((output) => decodeOutput(output).pipe(Effect.orDie)),
      ),
  });
  return (target: { readonly environmentId: EnvironmentId; readonly input: I }) =>
    family({ environmentId: target.environmentId, input: encodeInput(target.input) });
}
