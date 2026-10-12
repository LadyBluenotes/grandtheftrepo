import {
  ClaudeSettings,
  CodexSettings,
  ProviderInstanceId,
  type PolicyAgent,
} from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { resolveClaudeHomePath } from "../../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../../provider/Drivers/CodexHomeLayout.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { findBlock, type FoundBlock } from "./Render.ts";

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);
const decodeCodexSettingsSync = Schema.decodeSync(CodexSettings);

/**
 * The instruction file each agent reads, found the way its default instance's driver finds its
 * home: the instance's settings, then its environment over the server's. Claude's sits in its
 * config directory (`homePath`, else `CLAUDE_CONFIG_DIR`), Codex's in its shared home
 * (`homePath`, else `CODEX_HOME`), and Copilot's in `COPILOT_HOME`.
 */
export const targets = Effect.fn("InstructionFiles.targets")(function* () {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const hostEnvironment = yield* HostProcess.Environment;
  const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
  const instance = (id: string) => settings.providerInstances[ProviderInstanceId.make(id)];
  // The host environment is passed because the helper's own default is `process.env`.
  const environmentOf = (id: string) =>
    mergeProviderInstanceEnvironment(instance(id)?.environment, hostEnvironment);

  const claude = decodeClaudeSettings(instance("claudeAgent")?.config ?? {});
  const claudeDir = yield* resolveClaudeHomePath(
    { homePath: Option.isSome(claude) ? claude.value.homePath : "" },
    yield* environmentOf("claudeAgent"),
  );

  const codex = Option.getOrElse(decodeCodexSettings(instance("codex")?.config ?? {}), () =>
    decodeCodexSettingsSync({}),
  );
  // As the Codex usage reader does: `CODEX_HOME` counts only when the settings name no home.
  const codexEnvironmentHome = (yield* environmentOf("codex")).CODEX_HOME?.trim();
  const codexHome = yield* resolveCodexHomeLayout(
    codex.setupMode !== "managed" &&
      !codex.homePath.trim() &&
      !codex.shadowHomePath.trim() &&
      codexEnvironmentHome
      ? { ...codex, homePath: codexEnvironmentHome }
      : codex,
  );

  // The merge expands only CODEX_HOME and CLAUDE_CONFIG_DIR; a `~` here is expanded as the usage reader does.
  const copilotHome = expandHomePath(
    (yield* environmentOf("copilot")).COPILOT_HOME?.trim() || path.join(home, ".copilot"),
    home,
  );
  return {
    claude: path.join(claudeDir, "CLAUDE.md"),
    codex: path.join(codexHome.sharedHomePath, "AGENTS.md"),
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
