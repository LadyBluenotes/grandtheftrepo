import {
  PluginHostError,
  PluginMethodError,
  type PluginGateway,
  type PluginMethod,
  type PluginMethodCall,
  type PluginMethodFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

interface PluginHandler<R> {
  readonly definition: PluginMethod;
  /** Takes the input as it crossed the wire and answers with the output encoded. */
  readonly run: (input: unknown) => Effect.Effect<unknown, PluginHostError | PluginMethodError, R>;
}

/** Plugin method name to its handler. The host merges every plugin's table behind the gateway. */
export type DispatchTable<R = never> = { readonly [method: string]: PluginHandler<R> };

const formatIssue = SchemaIssue.makeFormatterDefault();

/**
 * A plugin's dispatch table: one `run` per method in `methods`, typed by that method's schemas.
 * Curried so the services `runs` need are inferred once `methods` has fixed the keys. The input is
 * decoded before `run`; the output and a typed failure are encoded after it, the failure inside
 * `PluginMethodError`. Defects and interrupts pass through untouched.
 */
export const defineHandlers =
  <const Methods extends { readonly [K in keyof Methods]: PluginMethod }>(methods: Methods) =>
  <R = never>(runs: {
    readonly [K in keyof Methods]: (
      input: Methods[K]["input"]["Type"],
    ) => Effect.Effect<Methods[K]["output"]["Type"], PluginMethodFailure<Methods[K]>, R>;
  }): DispatchTable<R> => {
    const handler = <K extends keyof Methods>(key: K): PluginHandler<R> => {
      const definition = methods[key];
      const decodeInput = Schema.decodeUnknownEffect(definition.input);
      const encodeOutput = Schema.encodeUnknownEffect(definition.output);
      const encodeError =
        definition.error === undefined ? undefined : Schema.encodeUnknownEffect(definition.error);
      return {
        definition,
        run: (raw) =>
          Effect.gen(function* () {
            const input = yield* decodeInput(raw).pipe(
              Effect.mapError(
                (error) => new PluginHostError({ message: formatIssue(error.issue) }),
              ),
            );
            const output = yield* runs[key](input).pipe(
              Effect.catch((failure) =>
                Effect.gen(function* () {
                  const error =
                    encodeError === undefined
                      ? String(failure)
                      : yield* encodeError(failure).pipe(Effect.orDie);
                  return yield* new PluginMethodError({ method: definition.method, error });
                }),
              ),
            );
            return yield* encodeOutput(output).pipe(Effect.orDie);
          }),
      };
    };
    const table: Record<string, PluginHandler<R>> = {};
    for (const key in methods) table[methods[key].method] = handler(key);
    return table;
  };

/** Runs `call` when its method is registered under `gateway`, whose RPC already checked the scope. */
export const dispatch = <R>(
  gateway: PluginGateway,
  table: DispatchTable<R>,
  call: PluginMethodCall,
) =>
  Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan({ "plugin.method": call.method });
    const handler = Object.hasOwn(table, call.method) ? table[call.method] : undefined;
    if (handler === undefined)
      return yield* new PluginHostError({ message: `Unknown plugin method "${call.method}".` });
    if (handler.definition.gateway !== gateway)
      return yield* new PluginHostError({
        message: `Method "${call.method}" needs the ${handler.definition.gateway} scope.`,
      });
    return yield* handler.run(call.input);
  });
