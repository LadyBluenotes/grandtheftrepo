import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { attentionRowThread } from "./attentionTarget";

describe("attentionRowThread", () => {
  const threadId = ThreadId.make("thread-1");

  it("opens the row's thread for the targets mobile has always followed", () => {
    for (const target of ["thread", "board", "settings"] as const) {
      expect(attentionRowThread({ resumeAction: { label: "Go", target }, threadId })).toBe(
        threadId,
      );
    }
    expect(
      attentionRowThread({ resumeAction: { label: "Go", target: "board" }, threadId: null }),
    ).toBeNull();
  });

  it("keeps a plugin row on the board, even when it names a thread", () => {
    expect(
      attentionRowThread({
        resumeAction: {
          label: "Open item",
          target: "plugin",
          pluginId: "learning",
          recordId: "12",
        },
        threadId,
      }),
    ).toBeNull();
  });
});
