/**
 * Skill discovery for the `$` picker via `copilot skill list --json`, which
 * reports every skill the CLI would load for a workspace (project, personal,
 * plugin, and built-in) with its own ignore rules applied. Probe failures stay
 * typed so workspace snapshots do not cache an empty catalog.
 *
 * @module provider-copilot/server/skills
 */
import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";

import type { CopilotSettings } from "../settings.ts";

const COPILOT_SKILLS_PROBE_TIMEOUT_MS = 4_000;

const CopilotSkillList = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.optional(Schema.String),
      source: Schema.optional(Schema.String),
      path: Schema.String,
      enabled: Schema.optional(Schema.Boolean),
    }),
  ),
);
const decodeCopilotSkillList = Schema.decodeUnknownOption(CopilotSkillList);

class CopilotSkillsProbeError extends Schema.TaggedError<CopilotSkillsProbeError>()(
  "CopilotSkillsProbeError",
  {
    stage: Schema.Literals(["spawn", "timeout", "exit", "decode"]),
    cwd: Schema.optional(Schema.String),
    exitCode: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const location = this.cwd === undefined ? "" : ` for '${this.cwd}'`;
    const exitCode = this.exitCode === undefined ? "" : ` with exit code ${this.exitCode}`;
    return `\`copilot skill list --json\` failed during ${this.stage}${location}${exitCode}.`;
  }
}

/** Copilot's `source` values onto the scopes clients group skills by. */
function copilotSkillScope(source: string | undefined): string | undefined {
  if (source === undefined) return undefined;
  if (source.startsWith("personal")) return "personal";
  if (source === "builtin") return "system";
  return source;
}

export function copilotSkillsFromList(
  output: string,
): ReadonlyArray<ServerProviderSkill> | undefined {
  const decoded = decodeCopilotSkillList(output);
  if (Option.isNone(decoded)) return undefined;
  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const skill of decoded.value) {
    const name = skill.name.trim();
    const path = skill.path.trim();
    if (!name || !path || skillsByName.has(name)) continue;
    const description = skill.description?.trim();
    const scope = copilotSkillScope(skill.source?.trim());
    skillsByName.set(name, {
      name,
      path,
      enabled: skill.enabled !== false,
      ...(scope ? { scope } : {}),
      ...(description ? { description } : {}),
    });
  }
  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export const discoverCopilotSkills = Effect.fn("discoverCopilotSkills")(function* (
  copilotSettings: Pick<CopilotSettings, "binaryPath">,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
) {
  const command = copilotSettings.binaryPath || "copilot";
  const result = yield* Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(command, ["skill", "list", "--json"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        ...(cwd ? { cwd } : {}),
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  }).pipe(
    Effect.mapError(
      (cause) => new CopilotSkillsProbeError({ stage: "spawn", ...(cwd ? { cwd } : {}), cause }),
    ),
    Effect.timeoutOption(COPILOT_SKILLS_PROBE_TIMEOUT_MS),
  );

  if (Option.isNone(result)) {
    return yield* new CopilotSkillsProbeError({ stage: "timeout", ...(cwd ? { cwd } : {}) });
  }
  const output = result.value;
  if (output.code !== 0) {
    return yield* new CopilotSkillsProbeError({
      stage: "exit",
      ...(cwd ? { cwd } : {}),
      exitCode: output.code,
    });
  }
  const skills = copilotSkillsFromList(output.stdout);
  if (!skills) {
    return yield* new CopilotSkillsProbeError({ stage: "decode", ...(cwd ? { cwd } : {}) });
  }
  return skills;
});
