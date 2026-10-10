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
  copilotAuthFromEnvironment,
} from "./status.ts";

const decodeCopilotSettings = Schema.decodeSync(CopilotSettings);

/** Environment with every token variable cleared, so the host's own tokens cannot leak in. */
const noTokenEnvironment = {
  ...process.env,
  COPILOT_GITHUB_TOKEN: "",
  GH_TOKEN: "",
  GITHUB_TOKEN: "",
};

/**
 * A stand-in for the Copilot CLI: `--version` prints a canned banner and
 * `--acp` runs a one-method ACP agent that answers `initialize`. The shape
 * mirrors Copilot CLI 1.0.95, which negotiates ACP v1 and advertises a
 * terminal-only `copilot-login` auth method.
 */
const ACP_AGENT_SOURCE = [
  'import * as NodeReadline from "node:readline";',
  "const args = process.argv.slice(2);",
  'if (args[0] === "--version") {',
  '  process.stdout.write("GitHub Copilot CLI 1.0.95\\n");',
  "  process.exit(0);",
  "}",
  'if (args.join(" ") !== "--acp") process.exit(1);',
  "for await (const line of NodeReadline.createInterface({ input: process.stdin })) {",
  "  const request = JSON.parse(line);",
  "  if (request.id === undefined) continue;",
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

describe("copilotAuthFromEnvironment", () => {
  it("reports a token variable as API-key auth and otherwise stays unknown", () => {
    expect(copilotAuthFromEnvironment({ GH_TOKEN: "github_pat_test" })).toEqual({
      status: "authenticated",
      type: "api_key",
      label: "GitHub token",
    });
    expect(copilotAuthFromEnvironment({ GH_TOKEN: "" })).toEqual({ status: "unknown" });
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
        "full-access",
      ]);
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
        noTokenEnvironment,
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
            noTokenEnvironment,
          );
        }),
      );
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("GitHub Copilot CLI is installed but failed to run.");
      expect(snapshot.message).not.toContain(secretStderr);
    }),
  );

  it.effect("reports ready once the ACP server answers initialize, without opening a session", () =>
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
            noTokenEnvironment,
          );
        }),
      );
      expect(snapshot.status).toBe("ready");
      expect(snapshot.version).toBe("1.0.95");
      // Only a session can tell whether `copilot login` ran; the probe never opens one.
      expect(snapshot.auth).toEqual({ status: "unknown" });
      expect(snapshot.models.map((model) => [model.slug, model.isDefault ?? false])).toEqual([
        ["default", true],
        ["gpt-5.3-codex", false],
      ]);
      expect(snapshot.slashCommands.map((command) => command.name)).toEqual(["compact"]);
    }),
  );

  it.effect("treats a token variable as authenticated", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-copilot-token-" });
          const binaryPath = writeFakeCli({
            directory: dir,
            name: "copilot",
            source: ACP_AGENT_SOURCE,
          });
          return yield* checkCopilotProviderStatus(
            decodeCopilotSettings({ enabled: true, binaryPath }),
            { ...noTokenEnvironment, COPILOT_GITHUB_TOKEN: "github_pat_test" },
          );
        }),
      );
      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth).toEqual({
        status: "authenticated",
        type: "api_key",
        label: "GitHub token",
      });
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
            noTokenEnvironment,
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
