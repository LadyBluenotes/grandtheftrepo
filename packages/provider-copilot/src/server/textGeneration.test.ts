// @effect-diagnostics nodeBuiltinImport:off - reads the fake agent's request log written by the stub.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";

import { CopilotSettings } from "../settings.ts";
import { declineCopilotPermission, makeCopilotTextGeneration } from "./textGeneration.ts";

const decodeCopilotSettings = Schema.decodeSync(CopilotSettings);

/**
 * A fake `copilot --acp`: an ACP v2 agent whose `session/new`
 * advertises a model config option (v2 wire shape, `configId`), asks
 * permission for a tool call on every prompt, and then streams
 * `T3_ACP_PROMPT_RESPONSE_TEXT`. Under v2 `session/prompt` only acknowledges the
 * prompt; the turn ends on a `state_update` to `idle` carrying the stop reason.
 */
const TEXT_AGENT_SOURCE = [
  'import * as NodeFS from "node:fs";',
  'import * as NodeReadline from "node:readline";',
  "const args = process.argv.slice(2);",
  'if (args.join(" ") !== "--acp") process.exit(1);',
  'const sessionId = "copilot-text-session";',
  'let currentModel = "gpt-5.3-codex";',
  "let nextId = 1000;",
  "const pending = new Map();",
  "const write = (message) => process.stdout.write(JSON.stringify(message) + '\\n');",
  "const modelOption = () => ({",
  '  configId: "model", name: "Model", category: "model", type: "select", currentValue: currentModel,',
  '  options: [{ value: "gpt-5.3-codex", name: "GPT-5.3 Codex" }, { value: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" }],',
  "});",
  "for await (const line of NodeReadline.createInterface({ input: process.stdin })) {",
  "  const message = JSON.parse(line);",
  "  if (process.env.T3_ACP_REQUEST_LOG_PATH) NodeFS.appendFileSync(process.env.T3_ACP_REQUEST_LOG_PATH, line + '\\n');",
  "  if (message.id !== undefined && message.method === undefined) {",
  "    const resolve = pending.get(message.id);",
  "    pending.delete(message.id);",
  "    resolve?.(message);",
  "    continue;",
  "  }",
  "  if (message.id === undefined) continue;",
  "  let result;",
  "  switch (message.method) {",
  '    case "initialize":',
  '      result = { protocolVersion: 2, info: { name: "copilot", version: "1.0.95" }, capabilities: {} };',
  "      break;",
  '    case "session/new":',
  "      result = { sessionId, configOptions: [modelOption()] };",
  "      break;",
  '    case "session/set_config_option":',
  "      currentModel = message.params.value;",
  "      result = { configOptions: [modelOption()] };",
  "      break;",
  '    case "session/prompt":',
  "      // Answered off the read loop: the permission reply arrives as a later line.",
  "      void (async () => {",
  "        const id = nextId++;",
  "        const answered = new Promise((resolve) => pending.set(id, resolve));",
  '        write({ jsonrpc: "2.0", id, method: "session/request_permission", params: {',
  "          sessionId,",
  '          toolCall: { toolCallId: "call-1", title: "git log", kind: "execute", status: "pending" },',
  '          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }],',
  "        } });",
  "        const answer = await answered;",
  "        if (process.env.T3_ACP_PERMISSION_LOG_PATH) NodeFS.appendFileSync(process.env.T3_ACP_PERMISSION_LOG_PATH, JSON.stringify(answer.result) + '\\n');",
  '        write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: {',
  '          sessionUpdate: "agent_message_chunk", content: { type: "text", text: process.env.T3_ACP_PROMPT_RESPONSE_TEXT ?? "" },',
  "        } } });",
  '        write({ jsonrpc: "2.0", id: message.id, result: {} });',
  '        write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: {',
  '          sessionUpdate: "state_update", state: "idle", stopReason: "end_turn",',
  "        } } });",
  "      })();",
  "      continue;",
  "    default:",
  '      write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });',
  "      continue;",
  "  }",
  '  write({ jsonrpc: "2.0", id: message.id, result });',
  "}",
  "",
].join("\n");

function readJsonLines(filePath: string): ReadonlyArray<Record<string, unknown>> {
  return NodeFS.readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("declineCopilotPermission", () => {
  it("picks the agent's reject option and otherwise cancels", () => {
    expect(
      declineCopilotPermission({
        sessionId: "s",
        toolCall: { toolCallId: "c", title: "rm -rf", kind: "execute", status: "pending" },
        options: [
          { optionId: "y", name: "Allow", kind: "allow_once" },
          { optionId: "n", name: "Reject", kind: "reject_once" },
        ],
      }),
    ).toEqual({ outcome: { outcome: "selected", optionId: "n" } });
    expect(
      declineCopilotPermission({
        sessionId: "s",
        toolCall: { toolCallId: "c", title: "rm -rf", kind: "execute", status: "pending" },
        options: [{ optionId: "y", name: "Allow", kind: "allow_once" }],
      }),
    ).toEqual({ outcome: { outcome: "cancelled" } });
  });
});

it.layer(NodeServices.layer)("makeCopilotTextGeneration", (it) => {
  it.effect("generates through a session launcher, declines tools, and sets a named model", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-copilot-text-" });
      const requestLogPath = NodePath.join(dir, "requests.ndjson");
      const permissionLogPath = NodePath.join(dir, "permissions.ndjson");
      const binaryPath = writeFakeCli({
        directory: NodePath.join(dir, "bin"),
        name: "copilot",
        source: TEXT_AGENT_SOURCE,
        env: {
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_PERMISSION_LOG_PATH: permissionLogPath,
          T3_ACP_PROMPT_RESPONSE_TEXT:
            "Here you go:\n" +
            JSON.stringify({ subject: "Add Copilot provider", body: "Wire up the ACP runtime." }),
        },
      });
      const textGeneration = yield* makeCopilotTextGeneration(
        decodeCopilotSettings({
          enabled: true,
          binaryPath: "/not/used/copilot",
          sessionBinaryPath: binaryPath,
        }),
        { ...process.env, COPILOT_AUTO_UPDATE: "" },
      );

      const generated = yield* textGeneration.generateCommitMessage({
        cwd: dir,
        branch: "feature/copilot",
        stagedSummary: "M packages/provider-copilot/src/server/driver.ts",
        stagedPatch: "diff --git a/driver.ts b/driver.ts",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("copilot"),
          "claude-sonnet-4.5",
        ),
      });
      expect(generated.subject).toBe("Add Copilot provider");
      expect(generated.body).toBe("Wire up the ACP runtime.");

      const requests = readJsonLines(requestLogPath);
      expect(
        requests.some(
          (request) =>
            request.method === "session/set_config_option" &&
            (request.params as { value?: string }).value === "claude-sonnet-4.5",
        ),
      ).toBe(true);
      expect(readJsonLines(permissionLogPath)).toEqual([
        { outcome: { outcome: "selected", optionId: "reject" } },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the CLI's configured model for the default slug", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-copilot-text-default-" });
      const requestLogPath = NodePath.join(dir, "requests.ndjson");
      const binaryPath = writeFakeCli({
        directory: NodePath.join(dir, "bin"),
        name: "copilot",
        source: TEXT_AGENT_SOURCE,
        env: {
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ title: "Copilot provider" }),
        },
      });
      const textGeneration = yield* makeCopilotTextGeneration(
        decodeCopilotSettings({ enabled: true, binaryPath }),
      );
      const generated = yield* textGeneration.generateThreadTitle({
        cwd: dir,
        message: "Add a Copilot provider package",
        modelSelection: createModelSelection(ProviderInstanceId.make("copilot"), "default"),
      });
      expect(generated.title).toBe("Copilot provider");
      expect(
        readJsonLines(requestLogPath).some(
          (request) => request.method === "session/set_config_option",
        ),
      ).toBe(false);
    }).pipe(Effect.scoped),
  );
});
