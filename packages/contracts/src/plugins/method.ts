import type * as Schema from "effect/Schema";

/** The gateway RPC a plugin method is called through; each one carries its own scope. */
export type PluginGateway = "read" | "operate" | "settingsWrite";

/**
 * One plugin method behind the gateway RPCs. `input` and `output` cross the wire encoded; `error`
 * is the method's own failure, which reaches the client inside `PluginMethodError`. The type
 * parameters are the decoded input, output and failure, for code that reads them back.
 */
export interface PluginMethod<I = unknown, O = unknown, F = unknown> {
  readonly method: string;
  readonly gateway: PluginGateway;
  readonly input: Schema.Codec<I, unknown>;
  readonly output: Schema.Codec<O, unknown>;
  readonly error?: Schema.Codec<F, unknown>;
}

/** What a method's `error` schema decodes to; never for a method without one. */
export type PluginMethodFailure<M extends PluginMethod> = M extends {
  readonly error: infer E extends Schema.Codec<unknown, unknown>;
}
  ? E["Type"]
  : never;

/**
 * A plugin's methods by short name, kept with their literal types. Lives apart from `host.ts`
 * because `host.ts` imports every plugin contract file, and those call this at load.
 */
export const definePluginMethods = <const Methods extends Record<string, PluginMethod>>(
  methods: Methods,
): Methods => methods;
