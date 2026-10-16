import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as ServerConfig from "../../config.ts";

/** The global rules every installed block starts with: `RULES.md` in the state directory. */
export const rulesPath = Effect.fn("InstructionFiles.rulesPath")(function* () {
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  return path.join(stateDir, "RULES.md");
});
