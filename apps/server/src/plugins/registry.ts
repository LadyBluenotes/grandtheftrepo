import type { ServerPlugin } from "./Plugin.ts";
import * as Kanban from "./kanban/index.ts";
import * as Learning from "./learning/index.ts";
import * as Routing from "./routing/index.ts";
import * as Telemetry from "./telemetry/index.ts";

const plugins = [
  Kanban.plugin,
  Telemetry.plugin,
  Routing.plugin,
  Learning.plugin,
] as const satisfies ReadonlyArray<ServerPlugin<unknown, unknown>>;

type RequirementsOf<P> = P extends ServerPlugin<infer R, unknown> ? R : never;
type McpRequirementsOf<P> = P extends ServerPlugin<unknown, infer R> ? R : never;
/** Services the registered plugins' layers need from the server's runtime chain. */
export type PluginRequirements = RequirementsOf<(typeof plugins)[number]>;
/** Services the registered plugins' MCP tools need from the `/mcp` server's layer. */
export type PluginMcpRequirements = McpRequirementsOf<(typeof plugins)[number]>;

/** Every plugin this server knows. Order decides sweep order within a tick; dependencies still resolve by id. */
export const registry: ReadonlyArray<ServerPlugin<PluginRequirements, PluginMcpRequirements>> =
  plugins;
