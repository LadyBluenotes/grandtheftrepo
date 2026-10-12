import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { offeredModels } from "./state";

const instanceId = ProviderInstanceId.make("alpha");
const provider: ServerProvider = {
  driver: ProviderDriverKind.make("codex"),
  instanceId,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  checkedAt: "2026-10-12T00:00:00.000Z",
  auth: { status: "authenticated" },
  models: [
    { slug: "a-1", name: "A 1", isCustom: false, capabilities: null },
    { slug: "a-2", name: "A 2", isCustom: false, capabilities: null },
    { slug: "mine", name: "Mine", isCustom: true, capabilities: null },
  ],
  skills: [],
  slashCommands: [],
};

describe("offeredModels", () => {
  it("lists every model when nothing is hidden", () => {
    expect(offeredModels(provider, null).map((model) => model.slug)).toEqual([
      "a-1",
      "a-2",
      "mine",
    ]);
  });

  it("drops hidden catalog models but keeps custom ones, as the server does", () => {
    const preferences = { [instanceId]: { hiddenModels: ["a-2", "mine"], modelOrder: [] } };
    expect(offeredModels(provider, preferences).map((model) => model.slug)).toEqual([
      "a-1",
      "mine",
    ]);
  });
});
