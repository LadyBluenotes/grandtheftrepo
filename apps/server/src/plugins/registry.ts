import type { ServerPlugin } from "./Plugin.ts";
import * as Kanban from "./kanban/index.ts";
import * as Routing from "./routing/index.ts";

const plugins = [Kanban.plugin, Routing.plugin] as const satisfies ReadonlyArray<
  ServerPlugin<unknown>
>;

type RequirementsOf<P> = P extends ServerPlugin<infer R> ? R : never;
/** Services the registered plugins need from the server; the layer chain provides them. */
export type PluginRequirements = RequirementsOf<(typeof plugins)[number]>;

/** Every plugin this server knows. Order decides sweep order within a tick; dependencies still resolve by id. */
export const registry: ReadonlyArray<ServerPlugin<PluginRequirements>> = plugins;
