import { assert, describe, it } from "@effect/vitest";

import { deliveredCheck, filesCheck } from "./readiness.ts";

describe("filesCheck", () => {
  it("is ready when the server can write every agent's instruction file", () => {
    const check = filesCheck([
      { path: "/repo/CLAUDE.md", writable: true },
      { path: "/repo/AGENTS.md", writable: true },
    ]);
    assert.strictEqual(check.status, "ready");
  });

  it("names a file it cannot write", () => {
    const check = filesCheck([
      { path: "/repo/CLAUDE.md", writable: true },
      { path: "/repo/AGENTS.md", writable: false },
    ]);
    assert.strictEqual(check.status, "attention");
    assert.strictEqual(
      check.sentence,
      "The server cannot write /repo/AGENTS.md, so the knowledge index cannot be installed there.",
    );
  });
});

describe("deliveredCheck", () => {
  it("is ready when every agent in use holds the pages as accepted", () => {
    const check = deliveredCheck(2, [
      { agent: "claude", status: "ok", path: "/repo/CLAUDE.md" },
      { agent: "codex", status: "ok", path: "/repo/AGENTS.md" },
    ]);
    assert.strictEqual(check.status, "ready");
    assert.strictEqual(
      check.sentence,
      "2 accepted pages are delivered and indexed for Claude and Codex.",
    );
  });

  it("names the agents whose pages or index drifted or went missing", () => {
    const check = deliveredCheck(1, [
      { agent: "claude", status: "drifted", path: "/repo/CLAUDE.md" },
      { agent: "codex", status: "ok", path: "/repo/AGENTS.md" },
    ]);
    assert.strictEqual(check.status, "attention");
    assert.strictEqual(
      check.sentence,
      "Pages are not as accepted for Claude (drifted); install from the Knowledge screen.",
    );
    assert.strictEqual(check.target, "plugin");
  });
});
