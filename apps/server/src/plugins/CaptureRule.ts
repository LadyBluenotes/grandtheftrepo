import { setPluginOrchestrationInstructions } from "@t3tools/provider-core/server/orchestrationInstructions";
import * as Effect from "effect/Effect";

/**
 * When an agent should record what it learned, and with which tool. Tool descriptions say what a
 * tool does, never when to call it, so this rides on the orchestration instructions, which every
 * adapter sends only to a turn that has the `t3-code` MCP server. It is sent on every such turn:
 * keep it short. Each line names tools of one plugin and is left out while that plugin is off, so
 * the rule never points at a tool the MCP server does not have.
 */
const lines: ReadonlyArray<{ readonly plugin: string; readonly text: string }> = [
  {
    plugin: "kanban",
    text: "When you choose one approach over another, look for it with `kanban_list` kind `decision`, then record it with `kanban_write` `decision.create` if it is not there.",
  },
  // A problem found outside the task goes here, with the findings tool, once that tool exists.
  {
    plugin: "learning",
    text: "When something went wrong that should not recur, call `learning_correction_add` with a `declaredMode`.",
  },
  {
    plugin: "knowledge",
    text: "When a fact took real effort to establish, call `knowledge_propose`.",
  },
];

/** The rule for the running plugins, or nothing while kanban is off. */
export const render = (activeIds: ReadonlySet<string>): string => {
  if (!activeIds.has("kanban")) return "";
  const bullets = lines.filter((line) => activeIds.has(line.plugin)).map((line) => line.text);
  return `\n### Record as you work\n\n${bullets.map((text) => `- ${text}`).join("\n")}\n`;
};

/** Adds the rule to the orchestration instructions until the scope closes. */
export const install = (activeIds: ReadonlySet<string>) =>
  Effect.acquireRelease(
    Effect.sync(() => setPluginOrchestrationInstructions(render(activeIds))),
    () => Effect.sync(() => setPluginOrchestrationInstructions("")),
  );
