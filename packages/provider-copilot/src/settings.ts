/**
 * Copilot instance settings. Shared by the server driver and the client
 * settings form, so it holds only browser-safe schema code.
 *
 * @module provider-copilot/settings
 */
import {
  CustomModelSetting,
  TrimmedString,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const CopilotSettings = makeProviderSettingsSchema(
  {
    // On by default like Codex and Claude; users turn it off from Settings.
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("copilot").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the GitHub Copilot CLI binary.",
        providerSettingsForm: { placeholder: "copilot", clearWhenEmpty: "omit" },
      }),
    ),
    sessionBinaryPath: Schema.optionalKey(TrimmedString).pipe(
      Schema.annotateKey({
        title: "Session launcher",
        description:
          "Optional executable or script for Copilot ACP sessions. Version checks, skills, and updates still use Binary path.",
        providerSettingsForm: { placeholder: "Use Binary path", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "sessionBinaryPath"],
  },
);
export type CopilotSettings = typeof CopilotSettings.Type;
