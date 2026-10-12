import * as Effect from "effect/Effect";

/** Proves the supervisor reaches the plugin. It examines and changes nothing, so a dry run is the same run. */
export const heartbeat = {
  plugin: "telemetry",
  name: "heartbeat",
  run: () => Effect.succeed({ examined: 0, acted: 0, flags: 0 }),
};
