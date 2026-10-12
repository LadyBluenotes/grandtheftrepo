import { ClaudeSettings, ProviderInstanceId, type PolicyAgent } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { resolveClaudeHomePath } from "../../provider/Drivers/ClaudeHome.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { findBlock, type FoundBlock } from "./Render.ts";

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const CLAUDE_INSTANCE = ProviderInstanceId.make("claudeAgent");

/**
 * The instruction file each agent reads from the user's home. Claude's sits in the config
 * directory this server starts Claude Code with, so an instance with a custom `homePath` is
 * not missed; Copilot's follows `COPILOT_HOME` the way the Copilot driver does.
 */
export const targets = Effect.fn("InstructionFiles.targets")(function* () {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const environment = yield* HostProcess.Environment;
  const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
  const claude = decodeClaudeSettings(settings.providerInstances[CLAUDE_INSTANCE]?.config ?? {});
  const claudeDir = yield* resolveClaudeHomePath(
    { homePath: Option.isSome(claude) ? claude.value.homePath : "" },
    environment,
  );
  const copilotHome = environment.COPILOT_HOME?.trim() || path.join(home, ".copilot");
  return {
    claude: path.join(claudeDir, "CLAUDE.md"),
    codex: path.join(home, ".codex", "AGENTS.md"),
    copilot: path.join(copilotHome, "copilot-instructions.md"),
  } satisfies Record<PolicyAgent, string>;
});

/** The file's text, or undefined when there is no file. */
export const read = Effect.fn("InstructionFiles.read")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  return (yield* fs.exists(filePath)) ? yield* fs.readFileString(filePath) : undefined;
});

export const write = (filePath: string, contents: string) =>
  writeFileStringAtomically({ filePath, contents });

/** The key's block as the file holds it now; absent when there is no file. */
export const verify = Effect.fn("InstructionFiles.verify")(function* (
  filePath: string,
  id: string,
) {
  const text = yield* read(filePath);
  return text === undefined ? ({ kind: "absent" } satisfies FoundBlock) : findBlock(text, id);
});
