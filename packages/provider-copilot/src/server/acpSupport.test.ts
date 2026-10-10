import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

import {
  applyCopilotAcpModelSelection,
  buildCopilotAcpSpawnInput,
  copilotAcpSpawnArgs,
  copilotLaunchRuntimeMode,
  hasCopilotTokenInEnvironment,
  currentCopilotModelIdFromSessionSetup,
  resolveCopilotAcpModelId,
} from "./acpSupport.ts";

describe("copilotAcpSpawnArgs", () => {
  it("launches the stdio ACP server asking unless T3 runs Full access", () => {
    expect(copilotAcpSpawnArgs()).toEqual(["--acp"]);
    expect(copilotAcpSpawnArgs("approval-required")).toEqual(["--acp"]);
    expect(copilotAcpSpawnArgs("auto-accept-edits")).toEqual(["--acp"]);
    expect(copilotAcpSpawnArgs("auto")).toEqual(["--acp"]);
  });

  it("maps Full access to Copilot's allow-all switch", () => {
    expect(copilotAcpSpawnArgs("full-access")).toEqual(["--acp", "--allow-all"]);
  });
});

describe("copilotLaunchRuntimeMode", () => {
  it("keeps the thread mode when no approval or sandbox override is set", () => {
    expect(
      copilotLaunchRuntimeMode({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/w",
      }),
    ).toBe("full-access");
  });

  it("launches asking when an explicit approval or sandbox policy is present", () => {
    expect(
      copilotLaunchRuntimeMode({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/w",
        approvalPolicy: "never",
      }),
    ).toBe("approval-required");
    expect(
      copilotLaunchRuntimeMode({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/w",
        sandboxPolicy: { type: "workspace-write" },
      }),
    ).toBe("approval-required");
  });
});

describe("buildCopilotAcpSpawnInput", () => {
  it("runs the configured binary with auto-update off and the instance environment", () => {
    expect(
      buildCopilotAcpSpawnInput({ binaryPath: "/opt/copilot/bin/copilot" }, "/tmp/project", {
        GH_TOKEN: "github_pat_test",
        COPILOT_AUTO_UPDATE: "true",
      }),
    ).toEqual({
      command: "/opt/copilot/bin/copilot",
      args: ["--acp"],
      cwd: "/tmp/project",
      env: { GH_TOKEN: "github_pat_test", COPILOT_AUTO_UPDATE: "false" },
    });
  });

  it("falls back to `copilot` on PATH and puts Full access on the argv", () => {
    const spawn = buildCopilotAcpSpawnInput(
      { binaryPath: "" },
      "/tmp/project",
      undefined,
      "full-access",
    );
    expect(spawn.command).toBe("copilot");
    expect(spawn.args).toEqual(["--acp", "--allow-all"]);
  });
});

describe("hasCopilotTokenInEnvironment", () => {
  it("sees any of the CLI's token variables and ignores blank values", () => {
    expect(hasCopilotTokenInEnvironment(undefined)).toBe(false);
    expect(hasCopilotTokenInEnvironment({ GH_TOKEN: "  ", GITHUB_TOKEN: "" })).toBe(false);
    expect(hasCopilotTokenInEnvironment({ GITHUB_TOKEN: "github_pat_c" })).toBe(true);
  });
});

describe("resolveCopilotAcpModelId", () => {
  it("normalizes empty and custom model ids", () => {
    expect(resolveCopilotAcpModelId(undefined)).toBe("default");
    expect(resolveCopilotAcpModelId("   ")).toBe("default");
    expect(resolveCopilotAcpModelId("  gpt-5.3-codex  ")).toBe("gpt-5.3-codex");
  });
});

const modelOption = (currentValue: string): EffectAcpSchema.SessionConfigOption => ({
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue,
  options: [
    { value: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
    { value: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
  ],
});

describe("currentCopilotModelIdFromSessionSetup", () => {
  it("prefers the model config option and falls back to v1 model state", () => {
    expect(
      currentCopilotModelIdFromSessionSetup({ configOptions: [modelOption("gpt-5.3-codex")] }),
    ).toBe("gpt-5.3-codex");
    expect(
      currentCopilotModelIdFromSessionSetup({
        models: { currentModelId: "claude-sonnet-4.5", availableModels: [] },
      }),
    ).toBe("claude-sonnet-4.5");
    expect(currentCopilotModelIdFromSessionSetup({})).toBeUndefined();
  });
});

describe("applyCopilotAcpModelSelection", () => {
  const makeRecordingRuntime = (failure?: EffectAcpErrors.AcpError) => {
    const modelCalls: Array<string> = [];
    const sessionModelCalls: Array<string> = [];
    const runtime = {
      setModel: (model: string) =>
        Effect.gen(function* () {
          modelCalls.push(model);
          if (failure) return yield* failure;
        }),
      setSessionModel: (modelId: string) =>
        Effect.gen(function* () {
          sessionModelCalls.push(modelId);
          if (failure) return yield* failure;
          return {};
        }),
    };
    return { runtime, modelCalls, sessionModelCalls };
  };

  it.effect("sets a named model through the session's model config option", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const applied = yield* applyCopilotAcpModelSelection({
        runtime,
        startResult: { sessionSetupResult: { configOptions: [modelOption("gpt-5.3-codex")] } },
        requestedModelId: "claude-sonnet-4.5",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual(["claude-sonnet-4.5"]);
      expect(applied).toBe("claude-sonnet-4.5");
    }),
  );

  it.effect("keeps the session's model for the default slug, `auto`, and a matching model", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const startResult = { sessionSetupResult: { configOptions: [modelOption("gpt-5.3-codex")] } };
      for (const requestedModelId of ["default", "auto", "gpt-5.3-codex"]) {
        expect(
          yield* applyCopilotAcpModelSelection({
            runtime,
            startResult,
            requestedModelId,
            mapError: (cause) => cause.message,
          }),
        ).toBe("gpt-5.3-codex");
      }
      expect(modelCalls).toEqual([]);
    }),
  );

  it.effect("uses session/set_model when a v1 session advertises model state", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls, sessionModelCalls } = makeRecordingRuntime();
      const applied = yield* applyCopilotAcpModelSelection({
        runtime,
        startResult: {
          sessionSetupResult: {
            models: {
              currentModelId: "gpt-5.3-codex",
              availableModels: [{ modelId: "gpt-5.3-codex", name: "GPT-5.3 Codex" }],
            },
          },
        },
        requestedModelId: "claude-sonnet-4.5",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(sessionModelCalls).toEqual(["claude-sonnet-4.5"]);
      expect(applied).toBe("claude-sonnet-4.5");
    }),
  );

  it.effect("skips the write when the session advertises no model option", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const applied = yield* applyCopilotAcpModelSelection({
        runtime,
        startResult: { sessionSetupResult: {} },
        requestedModelId: "claude-sonnet-4.5",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(applied).toBeUndefined();
    }),
  );

  it.effect("maps a rejected model through mapError", () =>
    Effect.gen(function* () {
      const { runtime } = makeRecordingRuntime(
        new EffectAcpErrors.AcpRequestError({ code: -32602, errorMessage: "Unknown model" }),
      );
      const result = yield* applyCopilotAcpModelSelection({
        runtime,
        startResult: { sessionSetupResult: { configOptions: [modelOption("gpt-5.3-codex")] } },
        requestedModelId: "nope",
        mapError: (cause) => `mapped:${cause.message}`,
      }).pipe(Effect.flip);
      expect(result).toContain("mapped:");
    }),
  );
});
