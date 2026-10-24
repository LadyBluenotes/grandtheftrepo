import { assert, it } from "@effect/vitest";

import { flagKeyedToProject } from "./attentionKeys.ts";

it("a key belongs to the project it ends with or has as a segment", () => {
  for (const key of [
    "budget:7:project:a",
    "policy:project:a:claude:/home/me/.claude/CLAUDE.md",
    "knowledge:project:a:page:tests:/work/a/.knowledge/tests.md",
    "promotion:project:a:promotion-1",
  ]) {
    assert.isTrue(flagKeyedToProject(key, "project:a"), key);
    assert.isFalse(flagKeyedToProject(key, "project:b"), key);
  }
});

it("a policy of the whole environment belongs to every project", () => {
  const key = "policy:*:claude:/home/me/.claude/CLAUDE.md";
  assert.isTrue(flagKeyedToProject(key, "project:a"));
  assert.isTrue(flagKeyedToProject(key, "project:b"));
});

it("a thread id, or the key of a project whose id only starts the same, belongs to no project", () => {
  assert.isFalse(flagKeyedToProject("thread:1", "project:a"));
  assert.isFalse(flagKeyedToProject("project:a", "project:a"));
  assert.isFalse(flagKeyedToProject("knowledge:project:ab:page", "project:a"));
});
