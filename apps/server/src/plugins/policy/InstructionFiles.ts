import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as ServerConfig from "../../config.ts";
import { findBlock, read, type FoundBlock } from "../InstructionBlocks.ts";
import { policyMarkers } from "./Render.ts";

/** The global rules every installed block starts with: `RULES.md` in the state directory. */
export const rulesPath = Effect.fn("InstructionFiles.rulesPath")(function* () {
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  return path.join(stateDir, "RULES.md");
});

/** The key's block as the file holds it now; absent when there is no file. */
export const verify = Effect.fn("InstructionFiles.verify")(function* (
  filePath: string,
  id: string,
) {
  const text = yield* read(filePath);
  return text === undefined
    ? ({ kind: "absent" } satisfies FoundBlock)
    : findBlock(text, policyMarkers(id));
});
