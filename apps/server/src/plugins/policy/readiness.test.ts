import { assert, describe, it } from "@effect/vitest";
import {
  POLICY_ENVIRONMENT_PROJECT_ID,
  ProjectId,
  type PolicyAgent,
  type PolicyDeliveryStatus,
  type PolicyListing,
} from "@t3tools/contracts";

import { deliveredCheck, directoriesCheck, type AgentHome } from "./readiness.ts";

const home = (agent: PolicyAgent, enabled: boolean, exists: boolean): AgentHome => ({
  agent,
  directory: `/home/me/.${agent}`,
  enabled,
  exists,
});

describe("directoriesCheck", () => {
  it("is ready when every agent in use has its directory", () => {
    const check = directoriesCheck([
      home("claude", true, true),
      home("codex", true, true),
      home("copilot", false, false),
    ]);
    assert.strictEqual(check.status, "ready");
    assert.strictEqual(check.sentence, "Claude and Codex each have their instruction directory.");
  });

  it("names an enabled agent whose directory is missing", () => {
    const check = directoriesCheck([home("claude", true, true), home("codex", true, false)]);
    assert.strictEqual(check.status, "attention");
    assert.strictEqual(
      check.sentence,
      "Codex's directory /home/me/.codex does not exist, so no policy reaches it; run Codex once to create it.",
    );
  });

  it("needs at least one agent in use", () => {
    assert.strictEqual(directoriesCheck([home("claude", false, true)]).status, "attention");
  });
});

const listing = (
  projectId: ProjectId,
  key: string,
  state: PolicyListing["state"],
  status: ReadonlyArray<[PolicyAgent, PolicyDeliveryStatus["status"]]>,
): PolicyListing => ({
  projectId,
  key,
  title: key,
  body: "",
  version: 1,
  state,
  updatedAt: "2026-10-01T00:00:00.000Z",
  versions: [],
  deliveries: [],
  status: status.map(([agent, value]) => ({
    agent,
    status: value,
    path: `/home/me/.${agent}/FILE.md`,
    blockMatches: value === "ok",
    rulesCurrent: true,
  })),
});

describe("deliveredCheck", () => {
  const project = ProjectId.make("project-1");

  it("is ready when each accepted environment policy is intact for every agent delivered to", () => {
    const check = deliveredCheck(
      [
        listing(POLICY_ENVIRONMENT_PROJECT_ID, "ponytail", "accepted", [
          ["claude", "ok"],
          ["codex", "ok"],
          ["copilot", "missing"],
        ]),
        listing(POLICY_ENVIRONMENT_PROJECT_ID, "draft-only", "draft", [["claude", "missing"]]),
        listing(project, "local", "accepted", [["claude", "missing"]]),
      ],
      ["claude", "codex"],
    );
    assert.strictEqual(check.status, "ready");
    assert.strictEqual(
      check.sentence,
      "1 accepted environment policy is delivered to Claude and Codex.",
    );
  });

  it("names each policy an agent lacks or holds out of date", () => {
    const check = deliveredCheck(
      [
        listing(POLICY_ENVIRONMENT_PROJECT_ID, "ponytail", "accepted", [
          ["claude", "outdated"],
          ["codex", "ok"],
        ]),
        listing(POLICY_ENVIRONMENT_PROJECT_ID, "caveman", "accepted", [
          ["claude", "ok"],
          ["codex", "missing"],
        ]),
      ],
      ["claude", "codex"],
    );
    assert.strictEqual(check.status, "attention");
    assert.strictEqual(
      check.sentence,
      "Ponytail is outdated for Claude and caveman is missing for Codex; install from the Policies screen.",
    );
    assert.strictEqual(check.target, "plugin");
  });
});
