import type { ServerPlugin } from "./Plugin.ts";

const plugins = [] as const satisfies ReadonlyArray<ServerPlugin<unknown>>;

type RequirementsOf<P> = P extends ServerPlugin<infer R> ? R : never;
/** Services the registered plugins need from the server; the layer chain provides them. */
export type PluginRequirements = RequirementsOf<(typeof plugins)[number]>;

/** Every plugin this server knows. Order does not matter; dependencies resolve by id. */
export const registry: ReadonlyArray<ServerPlugin<PluginRequirements>> = plugins;
