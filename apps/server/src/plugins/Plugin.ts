import type * as Layer from "effect/Layer";

/**
 * What a plugin contributes to the server. The host decides whether it runs
 * and wires it in; a plugin never edits an upstream file.
 */
export interface ServerPlugin<R = never> {
  readonly id: string;
  /** Ids of plugins that must run for this one to run. */
  readonly dependsOn: ReadonlyArray<string>;
  /** Services, reactors and sweeps. Built only when the plugin is active. */
  readonly layer: Layer.Layer<never, never, R>;
  /** MCP tools, already passed through `toolkitRegistration`. */
  readonly mcp?: Layer.Layer<never, never, R>;
}
