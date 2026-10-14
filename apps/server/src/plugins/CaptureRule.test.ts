import { assert, it } from "@effect/vitest";
import {
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  t3AcpPromptWithInstructions,
  t3OrchestrationPromptForFirstRun,
  t3OrchestrationSystemPrompt,
} from "@t3tools/provider-core/server/orchestrationInstructions";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { toolkitRegistration } from "../mcp/McpHttpServer.ts";
import { buildCodexAdditionalContext } from "../provider/CodexDeveloperInstructions.ts";
import * as CaptureRule from "./CaptureRule.ts";
import { registry } from "./registry.ts";

const prompt = "Fix the flaky test.";
const allActive = new Set(registry.map((plugin) => plugin.id));

/** The orchestration text each adapter family sends, with and without the `t3-code` MCP server. */
const turnInstructions = (hasT3Mcp: boolean) => [
  t3OrchestrationSystemPrompt(hasT3Mcp) ?? "",
  t3OrchestrationPromptForFirstRun({ prompt, runOrdinal: 1, hasT3Mcp }),
  t3AcpPromptWithInstructions({ prompt, state: { interactionMode: "default", hasT3Mcp } }),
  ...(hasT3Mcp
    ? [
        buildCodexAdditionalContext({ model: "gpt-5.4", reasoningEffort: "high" })
          .t3_code_orchestration!.value,
      ]
    : []),
];

it.effect("tells every turn with the MCP server when to record, while kanban runs", () =>
  Effect.gen(function* () {
    const upstream = T3_CODE_ORCHESTRATION_INSTRUCTIONS;
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* CaptureRule.install(allActive);
        for (const instructions of turnInstructions(true)) {
          assert.include(instructions, "`kanban_write` `decision.create`");
          assert.include(instructions, "`learning_correction_add` with a `declaredMode`");
          assert.include(instructions, "`knowledge_propose`");
        }
        for (const instructions of turnInstructions(false)) {
          assert.notInclude(instructions, "Record as you work");
        }
      }),
    );
    assert.strictEqual(T3_CODE_ORCHESTRATION_INSTRUCTIONS, upstream);
  }),
);

it.effect("says nothing while kanban is off", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const upstream = T3_CODE_ORCHESTRATION_INSTRUCTIONS;
      yield* CaptureRule.install(new Set(["learning", "knowledge"]));
      assert.strictEqual(t3OrchestrationSystemPrompt(true), upstream);
    }),
  ),
);

it("leaves out the line of a plugin that is off", () => {
  const rule = CaptureRule.render(new Set(["kanban", "knowledge"]));
  assert.include(rule, "`kanban_write`");
  assert.include(rule, "`knowledge_propose`");
  assert.notInclude(rule, "learning_correction_add");
});

it("names only tools the plugins register on the MCP server", () => {
  const registered = new Set<string>();
  const capture: typeof toolkitRegistration = (toolkit) => {
    for (const name of Object.keys(toolkit.tools)) registered.add(name);
    return Layer.empty;
  };
  for (const plugin of registry) plugin.mcp?.(capture);

  // A backticked snake_case word is a tool name; actions and fields use dots or camelCase.
  const named = [...CaptureRule.render(allActive).matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map(
    (match) => match[1]!,
  );
  assert.includeMembers(named, [
    "kanban_list",
    "kanban_write",
    "learning_correction_add",
    "knowledge_propose",
  ]);
  for (const name of named) assert.isTrue(registered.has(name), `no MCP tool named ${name}`);
});
