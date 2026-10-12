import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";

import { copilotSkillsFromList, discoverCopilotSkills } from "./skills.ts";

// What `copilot skill list --json` (CLI 1.0.95) printed for a project with
// `.github/skills` and `.claude/skills` entries plus a personal skill.
const SKILL_LIST_JSON = JSON.stringify([
  {
    name: "project-skill",
    description: "Project scoped skill",
    source: "project",
    path: "/work/.github/skills/project-skill",
    enabled: true,
  },
  {
    name: "personal-skill",
    description: "A personal skill",
    source: "personal-copilot",
    path: "/home/me/.copilot/skills/personal-skill",
    enabled: false,
  },
  {
    name: "github-pr-media",
    description: "Upload media to a PR",
    source: "builtin",
    path: "/cache/copilot/builtin/github-pr-media",
    enabled: true,
  },
  { name: "project-skill", source: "plugin", path: "/dup", enabled: true },
  { name: " ", source: "project", path: "/blank", enabled: true },
]);

describe("copilotSkillsFromList", () => {
  it("maps the CLI's catalog onto provider skills, sorted and deduplicated", () => {
    expect(copilotSkillsFromList(SKILL_LIST_JSON)).toEqual([
      {
        name: "github-pr-media",
        path: "/cache/copilot/builtin/github-pr-media",
        enabled: true,
        scope: "system",
        description: "Upload media to a PR",
      },
      {
        name: "personal-skill",
        path: "/home/me/.copilot/skills/personal-skill",
        enabled: false,
        scope: "personal",
        description: "A personal skill",
      },
      {
        name: "project-skill",
        path: "/work/.github/skills/project-skill",
        enabled: true,
        scope: "project",
        description: "Project scoped skill",
      },
    ]);
  });

  it("rejects output that is not a skill list", () => {
    expect(copilotSkillsFromList("Project skills:\n  foo - bar\n")).toBeUndefined();
    expect(copilotSkillsFromList('{"skills": []}')).toBeUndefined();
  });
});

it.layer(NodeServices.layer)("discoverCopilotSkills", (it) => {
  it.effect("runs `copilot skill list --json` in the workspace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-copilot-skills-" });
      const binaryPath = writeFakeCli({
        directory: dir,
        name: "copilot",
        source: [
          'if (process.argv.slice(2).join(" ") !== "skill list --json") process.exit(1);',
          `process.stdout.write(${JSON.stringify(SKILL_LIST_JSON)});`,
          "",
        ].join("\n"),
      });
      const skills = yield* discoverCopilotSkills({ binaryPath }, process.env, dir);
      expect(skills.map((skill) => skill.name)).toEqual([
        "github-pr-media",
        "personal-skill",
        "project-skill",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("fails typed when the CLI exits non-zero so the result is not cached", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-copilot-skills-fail-" });
      const binaryPath = writeFakeCli({
        directory: dir,
        name: "copilot",
        source: "process.exit(2);",
      });
      const error = yield* discoverCopilotSkills({ binaryPath }, process.env, dir).pipe(
        Effect.flip,
      );
      expect(error.stage).toBe("exit");
      expect(error.exitCode).toBe(2);
    }).pipe(Effect.scoped),
  );
});
