/**
 * Copilot's server entry: the driver and adapter driver the server registers.
 *
 * @module provider-copilot/server
 */
export { CopilotDriver, type CopilotDriverEnv } from "./server/driver.ts";
export { CopilotAdapterV2Driver, type CopilotAdapterV2DriverEnv } from "./server/adapter.ts";
