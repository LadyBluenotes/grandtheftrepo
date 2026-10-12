import { describe, expect, it } from "vite-plus/test";

import { scanScopeLabel, sinkTokensLabel } from "./state";

describe("sinkTokensLabel", () => {
  it("shows tokens per message going forward and observed tokens otherwise, as estimates", () => {
    expect(
      sinkTokensLabel({ framing: "forward_rate", tokensPerTurn: 2400, tokensObserved: null }),
    ).toBe("2.4K tokens per message, estimate");
    expect(
      sinkTokensLabel({ framing: "historical", tokensPerTurn: 0, tokensObserved: 18_000 }),
    ).toBe("18K tokens observed, estimate");
    expect(
      sinkTokensLabel({ framing: "forward_rate", tokensPerTurn: null, tokensObserved: 900 }),
    ).toBe("No token estimate");
  });
});

describe("scanScopeLabel", () => {
  it("says where project instruction files were scanned from", () => {
    expect(scanScopeLabel("canonical")).toBe(
      "Project instruction files were scanned from the home directory up.",
    );
    expect(scanScopeLabel("autopilot")).toBe(
      "Project instruction files were scanned from the last session's directory up.",
    );
  });
});
