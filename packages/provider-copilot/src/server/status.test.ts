import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";

import { CopilotSettings } from "../settings.ts";
import {
  buildInitialCopilotProviderSnapshot,
  checkCopilotProviderStatus,
  copilotAcpFailureMessage,
  copilotModelsFromSettings,
} from "./status.ts";

const decodeCopilotSettings = Schema.decodeSync(CopilotSettings);

/**
 * A stand-in for the Copilot CLI: `--version` prints a canned banner and
 * `--acp` runs an ACP agent that answers `initialize` and `authenticate`. The
 * shape mirrors Copilot CLI 1.0.95, which negotiates ACP v1, advertises a
 * `copilot-login` auth method, and answers `authenticate` with -32000 while
 * signed out (`T3_COPILOT_SIGNED_OUT=1`).
 */
const ACP_AGENT_SOURCE = [
  'import * as NodeReadline from "node:readline";',
  "const args = process.argv.slice(2);",
  'if (args[0] === "--version") {',
  '  process.stdout.write("GitHub Copilot CLI 1.0.95\\n");',
  "  process.exit(0);",
  "}",
  'if (args.join(" ") === "skill list --json") {',
  '  process.stdout.write(JSON.stringify([{ name: "deploy", description: "Ship it", source: "project", path: "/work/.github/skills/deploy", enabled: true }]));',
  "  process.exit(0);",
  "}",
  'if (args.join(" ") !== "--acp") process.exit(1);',
  "for await (const line of NodeReadline.createInterface({ input: process.stdin })) {",
  "  const request = JSON.parse(line);",
  "  if (request.id === undefined) continue;",
  '  if (request.method === "authenticate") {',
  "    process.stdout.write(JSON.stringify(process.env.T3_COPILOT_SIGNED_OUT",
  '      ? { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "Authentication required" } }',
  '      : { jsonrpc: "2.0", id: request.id, result: {} }) + "\\n");',
  "    continue;",
  "  }",
  '  if (request.method !== "initialize") {',
  '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } }) + "\\n");',
  "    continue;",
  "  }",
  "  process.stdout.write(",
  "    JSON.stringify({",
  '      jsonrpc: "2.0",',
  "      id: request.id,",
  "      result: {",
  "        protocolVersion: 1,",
  '        agentInfo: { name: "Copilot", title: "Copilot", version: "1.0.95" },',
  "        agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },",
  '        authMethods: [{ id: "copilot-login", name: "Log in with Copilot CLI" }],',
  "      },",
  '    }) + "\\n",',
  "  );",
  "}",
  "",
].join("\n");

describe("copilotModelsFromSettings", () => {
  it("keeps the default sentinel first and shares the session's options with every model", () => {
    const capabilities = {
      optionDescriptors: [
        {
          id: "reasoning_effort",
          label: "Reasoning effort",
          type: "select" as const,
          options: [{ id: "high", label: "High" }],
        },
      ],
    };
    const models = copilotModelsFromSettings(["my-custom"], {
      models: [{ slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities }],
      capabilities,
    });
    expect(models.map((model) => [model.slug, model.isDefault ?? false, model.isCustom])).toEqual([
      ["default", true, false],
      ["gpt-5.4", false, false],
      ["my-custom", false, true],
    ]);
    expect(models.map((model) => model.capabilities)).toEqual([
      capabilities,
      capabilities,
      capabilities,
    ]);
  });
});

describe("copilotAcpFailureMessage", () => {
  it("blames a pre-ACP release only when the version is known to predate it", () => {
    expect(copilotAcpFailureMessage("0.0.350")).toContain("predates ACP support");
    expect(copilotAcpFailureMessage("1.0.95")).toContain("failed to initialize");
    expect(copilotAcpFailureMessage(null)).toContain("failed to initialize");
  });
});

describe("buildInitialCopilotProviderSnapshot", () => {
  it.effect("is pending by default and disabled once turned off", () =>
    Effect.gen(function* () {
      const pending = yield* buildInitialCopilotProviderSnapshot(
        decodeCopilotSettings({ customModels: ["gpt-5.3-codex"] }),
      );
      expect(pending.enabled).toBe(true);
      expect(pending.status).toBe("warning");
      expect(pending.message).toContain("Checking");
      expect(pending.supportedRuntimeModes).toEqual([
        "approval-required",
        "auto-accept-edits",
        "auto",
        "full-access",
      ]);
      expect(pending.showInteractionModeToggle).toBe(true);
      expect(pending.models.map((model) => model.slug)).toEqual(["default", "gpt-5.3-codex"]);

      const disabled = yield* buildInitialCopilotProviderSnapshot(
        decodeCopilotSettings({ enabled: false }),
      );
      expect(disabled.enabled).toBe(false);
      expect(disabled.status).toBe("disabled");
      expect(disabled.models.map((model) => model.slug)).toEqual(["default"]);
    }),
  );
});

it.layer(NodeServices.layer)("checkCopilotProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkCopilotProviderStatus(
        decodeCopilotSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/copilot-binary",
        }),
        process.env,
      );
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      const secretStderr = "broken copilot install: secret-token-value";
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-copilot-version-" });
          const binaryPath = writeFakeCli({
            directory: dir,
            name: "copilot",
            source: [
              `process.stderr.write(${JSON.stringify(`${secretStderr}\n`)});`,
              "process.exit(2);",
              "",
            ].join("\n"),
          });
          return yield* checkCopilotProviderStatus(
            decodeCopilotSettings({ enabled: true, binaryPath }),
            process.env,
          );
        }),
      );
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("GitHub Copilot CLI is installed but failed to run.");
      expect(snapshot.message).not.toContain(secretStderr);
    }),
  );

  it.effect("reports ready and signed in once the ACP server accepts authenticate", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-copilot-probe-" });
          const binaryPath = writeFakeCli({
            directory: dir,
            name: "copilot",
            source: ACP_AGENT_SOURCE,
          });
          return yield* checkCopilotProviderStatus(
            decodeCopilotSettings({ enabled: true, binaryPath, customModels: ["gpt-5.3-codex"] }),
            { ...process.env, T3_COPILOT_SIGNED_OUT: "" },
          );
        }),
      );
      expect(snapshot.status).toBe("ready");
      expect(snapshot.version).toBe("1.0.95");
      expect(snapshot.auth).toEqual({
        status: "authenticated",
        type: "cached_token",
        label: "GitHub account",
      });
      expect(snapshot.models.map((model) => [model.slug, model.isDefault ?? false])).toEqual([
        ["default", true],
        ["gpt-5.3-codex", false],
      ]);
      expect(snapshot.slashCommands.map((command) => command.name)).toEqual([
        "compact",
        "context",
        "usage",
        "env",
        "mcp",
        "review",
        "research",
        "session",
      ]);
      expect(snapshot.skills).toEqual([
        {
          name: "deploy",
          path: "/work/.github/skills/deploy",
          enabled: true,
          scope: "project",
          description: "Ship it",
        },
      ]);
    }),
  );

  it.effect("reports a signed-out CLI as needing `copilot login`", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-copilot-signedout-" });
          const binaryPath = writeFakeCli({
            directory: dir,
            name: "copilot",
            source: ACP_AGENT_SOURCE,
          });
          return yield* checkCopilotProviderStatus(
            decodeCopilotSettings({ enabled: true, binaryPath }),
            { ...process.env, T3_COPILOT_SIGNED_OUT: "1" },
          );
        }),
      );
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.auth).toEqual({ status: "unauthenticated" });
      expect(snapshot.message).toContain("copilot login");
    }),
  );

  it.effect("reports an error when the CLI runs but does not speak ACP", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-copilot-noacp-" });
          const binaryPath = writeFakeCli({
            directory: dir,
            name: "copilot",
            source: [
              'if (process.argv[2] === "--version") {',
              '  process.stdout.write("GitHub Copilot CLI 0.0.350\\n");',
              "  process.exit(0);",
              "}",
              "process.stderr.write(\"error: unknown option '--acp'\\n\");",
              "process.exit(1);",
              "",
            ].join("\n"),
          });
          return yield* checkCopilotProviderStatus(
            decodeCopilotSettings({ enabled: true, binaryPath }),
            process.env,
          );
        }),
      );
      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe("0.0.350");
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("predates ACP support");
    }),
  );
});
