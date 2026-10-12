import { assert, it } from "@effect/vitest";

import { needsDelivery } from "./needsDelivery.ts";

const current = {
  version: 2,
  rulesHash: "rules-1",
  targetPath: "/home/claude/CLAUDE.md",
  verifiedAt: "2026-10-12T00:00:00.000Z",
};
const needs = (delivery: Parameters<typeof needsDelivery>[0]["delivery"]) =>
  needsDelivery({
    version: 2,
    rulesHash: "rules-1",
    targetPath: "/home/claude/CLAUDE.md",
    delivery,
  });

it("a verified delivery of the accepted version under today's rules into today's file is current", () => {
  assert.isFalse(needs(current));
});

it("every other delivery, or none, needs one", () => {
  assert.isTrue(needs(undefined));
  assert.isTrue(needs({ ...current, version: 1 }));
  assert.isTrue(needs({ ...current, rulesHash: "rules-0" }));
  assert.isTrue(needs({ ...current, targetPath: "/old-home/CLAUDE.md" }));
  assert.isTrue(needs({ ...current, verifiedAt: null }));
});
