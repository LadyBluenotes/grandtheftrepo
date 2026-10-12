import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as EffectAcpSchema from "effect-acp/compat";

import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";

import { copilotDiscoveryFromSession, discoverCopilotSession } from "./discovery.ts";

const modelOption: EffectAcpSchema.SessionConfigOption = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "claude-sonnet-4.6",
  options: [
    { value: "gpt-5.4", name: "GPT-5.4" },
    { value: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
  ],
};
const effortOption: EffectAcpSchema.SessionConfigOption = {
  id: "reasoning_effort",
  name: "Reasoning effort",
  type: "select",
  currentValue: "medium",
  options: [
    { value: "low", name: "Low" },
    { value: "medium", name: "Medium" },
    { value: "high", name: "High" },
  ],
};
const allowAllOption: EffectAcpSchema.SessionConfigOption = {
  id: "allow_all",
  name: "Allow all",
  type: "boolean",
  currentValue: false,
};

describe("copilotDiscoveryFromSession", () => {
  it("lists the model option's choices and keeps tuning options", () => {
    const discovery = copilotDiscoveryFromSession({
      configOptions: [modelOption, effortOption, allowAllOption],
    });
    expect(discovery.models.map((model) => model.slug)).toEqual(["gpt-5.4", "claude-sonnet-4.6"]);
    // Reasoning effort rides on every model; Copilot's permission switch stays with T3's modes.
    expect(discovery.capabilities.optionDescriptors?.map((option) => option.id)).toEqual([
      "reasoning_effort",
    ]);
    expect(discovery.models[0]?.capabilities).toEqual(discovery.capabilities);
  });

  it("falls back to ACP v1 model state when no model option exists", () => {
    const discovery = copilotDiscoveryFromSession({
      models: {
        currentModelId: "gpt-5.4",
        availableModels: [
          { modelId: "gpt-5.4", name: "GPT-5.4" },
          { modelId: "gpt-5.4", name: "duplicate" },
          { modelId: " ", name: "blank" },
        ],
      },
    });
    expect(discovery.models).toEqual([
      {
        slug: "gpt-5.4",
        name: "GPT-5.4",
        isCustom: false,
        capabilities: { optionDescriptors: [] },
      },
    ]);
  });
});

it.layer(NodeServices.layer)("discoverCopilotSession", (it) => {
  // Copilot CLI 1.0 negotiates ACP v1: models arrive as `session/new` model
  // state and tuning options as v1 config options.
  it.effect("opens one v1 session, reads its catalog, and closes it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-copilot-discovery-" });
      const binaryPath = writeFakeCli({
        directory: dir,
        name: "copilot",
        source: [
          'import * as NodeReadline from "node:readline";',
          'if (process.argv.slice(2).join(" ") !== "--acp") process.exit(1);',
          `const configOptions = ${JSON.stringify([effortOption])};`,
          `const models = ${JSON.stringify({
            currentModelId: "claude-sonnet-4.6",
            availableModels: [
              { modelId: "gpt-5.4", name: "GPT-5.4" },
              { modelId: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
            ],
          })};`,
          "const write = (message) => process.stdout.write(JSON.stringify(message) + '\\n');",
          "for await (const line of NodeReadline.createInterface({ input: process.stdin })) {",
          "  const request = JSON.parse(line);",
          "  if (request.id === undefined) continue;",
          "  const result =",
          '    request.method === "initialize" ? { protocolVersion: 1, agentInfo: { name: "Copilot", version: "1.0.95" }, agentCapabilities: { sessionCapabilities: { close: {} } } }',
          '    : request.method === "session/new" ? { sessionId: "discovery-session", configOptions, models }',
          '    : request.method === "session/close" ? {}',
          "    : undefined;",
          '  if (result === undefined) write({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });',
          '  else write({ jsonrpc: "2.0", id: request.id, result });',
          "}",
          "",
        ].join("\n"),
      });
      const discovery = yield* discoverCopilotSession({ binaryPath }, process.env, dir);
      expect(discovery.models.map((model) => model.slug)).toEqual(["gpt-5.4", "claude-sonnet-4.6"]);
      expect(discovery.capabilities.optionDescriptors?.[0]?.id).toBe("reasoning_effort");
    }).pipe(Effect.scoped),
  );
});
