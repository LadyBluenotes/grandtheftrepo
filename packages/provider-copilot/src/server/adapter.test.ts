import { describe, expect, it } from "@effect/vitest";
import * as EffectAcpErrors from "effect-acp/errors";

import { COPILOT_SIGNED_OUT_MESSAGE, copilotPromptFailure } from "./adapter.ts";

describe("copilotPromptFailure", () => {
  it("names the sign-in fix for ACP auth-required errors", () => {
    // What Copilot CLI 1.0.95 returns from session/new and authenticate while signed out.
    const failure = copilotPromptFailure(
      new EffectAcpErrors.AcpRequestError({
        code: -32000,
        errorMessage: "Authentication required",
      }),
    );
    expect(failure.class).toBe("permission_error");
    expect(failure.code).toBe("-32000");
    expect(failure.message).toBe(COPILOT_SIGNED_OUT_MESSAGE);
  });

  it("passes other agent errors through as provider errors", () => {
    const failure = copilotPromptFailure(
      new EffectAcpErrors.AcpRequestError({ code: -32602, errorMessage: "Unknown model" }),
    );
    expect(failure).toMatchObject({
      class: "provider_error",
      code: "-32602",
      message: "Unknown model",
    });
    expect(copilotPromptFailure(new Error("boom")).class).toBe("provider_error");
  });
});
