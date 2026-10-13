// @effect-diagnostics nodeBuiltinImport:off - a plain sha256 of text; Effect's Crypto has no digest.
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
import * as NodeCrypto from "node:crypto";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import * as ServerSettings from "../serverSettings.ts";

/**
 * Marked blocks that plugins keep in agent instruction files, and the files themselves. A block
 * runs from `<!-- fork-<plugin>:start key=<id> -->` to `<!-- fork-<plugin>:end key=<id> -->`;
 * a plugin owns the bytes between its markers and never touches any outside them. The policy
 * plugin writes into the files agents read from the user's home, the knowledge plugin into the
 * project's own.
 */

/** The hash form every marker header and delivery row carries. */
export const sha256 = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

export interface BlockMarkers {
  readonly start: string;
  readonly end: string;
  /** A line right after the start marker that begins with this is metadata, not content. */
  readonly header: string;
}

/** The markers of `plugin`'s block `id`. */
export const blockMarkers = (plugin: string, id: string): BlockMarkers => ({
  start: `<!-- fork-${plugin}:start key=${id} -->`,
  end: `<!-- fork-${plugin}:end key=${id} -->`,
  header: `<!-- fork-${plugin} hash=`,
});

export type FoundBlock =
  | { readonly kind: "absent" }
  /** One marker alone, duplicates, or the end before the start: only a person can fix it. */
  | { readonly kind: "damaged" }
  | {
      readonly kind: "found";
      /** Offsets of the block in the text: from the start marker to the end of the end marker. */
      readonly start: number;
      readonly end: number;
      /** sha256 of the lines between the start marker, or the header after it, and the end marker. */
      readonly hash: string;
    };

const count = (text: string, needle: string) => text.split(needle).length - 1;

/** The block in `text`, located by its markers. */
export const findBlock = (text: string, markers: BlockMarkers): FoundBlock => {
  const starts = count(text, markers.start);
  const ends = count(text, markers.end);
  if (starts === 0 && ends === 0) return { kind: "absent" };
  if (starts !== 1 || ends !== 1) return { kind: "damaged" };
  const from = text.indexOf(markers.start);
  const endAt = text.indexOf(markers.end);
  if (endAt < from) return { kind: "damaged" };
  let inside = text.slice(from + markers.start.length, endAt);
  if (inside.startsWith("\n")) inside = inside.slice(1);
  if (inside.startsWith(markers.header)) {
    const newline = inside.indexOf("\n");
    inside = newline === -1 ? "" : inside.slice(newline + 1);
  }
  return { kind: "found", start: from, end: endAt + markers.end.length, hash: sha256(inside) };
};

/** `text` with `block` in place of the found one, else appended after a blank line. Bytes outside the block never change. */
export const placeBlock = (
  text: string,
  found: Exclude<FoundBlock, { readonly kind: "damaged" }>,
  block: string,
): string => {
  if (found.kind === "found") return text.slice(0, found.start) + block + text.slice(found.end);
  if (text.length === 0) return `${block}\n`;
  const gap = text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  return `${text}${gap}${block}\n`;
};

/** `text` without the found block and the line break that ends it. Bytes outside the block never change. */
export const removeBlock = (
  text: string,
  found: Extract<FoundBlock, { readonly kind: "found" }>,
): string => {
  const after = text.startsWith("\n", found.end) ? found.end + 1 : found.end;
  return text.slice(0, found.start) + text.slice(after);
};

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);
const decodeCodexSettingsSync = Schema.decodeSync(CodexSettings);

/**
 * The instruction file each agent reads from the user's home, found the way its default
 * instance's driver finds its home: the instance's settings, then its environment over the
 * server's. Claude's sits in its config directory (`homePath`, else `CLAUDE_CONFIG_DIR`), Codex's
 * in its shared home (`homePath`, else `CODEX_HOME`), and Copilot's in `COPILOT_HOME`. An agent
 * whose directory exists is in use.
 */
export const targets = Effect.fn("InstructionBlocks.targets")(function* () {
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
export const read = Effect.fn("InstructionBlocks.read")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  return (yield* fs.exists(filePath)) ? yield* fs.readFileString(filePath) : undefined;
});

export const write = (filePath: string, contents: string) =>
  writeFileStringAtomically({ filePath, contents });
