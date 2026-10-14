import type { KanbanDecision, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as Attention from "../Attention.ts";
import * as PluginSupervisor from "../PluginSupervisor.ts";
import { decisionRef } from "./KanbanFiles.ts";
import * as KanbanStore from "./KanbanStore.ts";

const PLUGIN_ID = "kanban";
const FLAG_KIND = "decision_conflict";
const RESUME_ACTION = { label: "Open decisions", target: "board" } as const;

/** The project id sits between colons, so the project's board and report list the flag. */
const keyPrefix = (projectId: ProjectId) => `decision:${projectId}:`;

const flagText = (decision: KanbanDecision) =>
  `Decision "${decision.title}" (${decisionRef(decision)}) is conflicted.`;

/**
 * Builds the decisions sweep. It keeps one open `decision_conflict` flag per conflicted decision
 * in each loaded project, and clears it once the decision's state changes or the decision is gone.
 * A project the store has not loaded since the server started keeps its flags until it loads. On
 * state it has already reconciled it writes nothing; under a dry run it writes nothing at all.
 */
export const sweep = Effect.gen(function* () {
  const store = yield* KanbanStore.KanbanStore;
  const attention = yield* Attention.Attention;

  return Effect.fn("DecisionSweep.run")(function* (input: { readonly dryRun: boolean }) {
    const loaded = yield* store.loadedDecisions;
    let examined = 0;
    // A flag's key to the text it should carry.
    const wanted = new Map<string, string>();
    for (const [projectId, decisions] of loaded) {
      examined += decisions.length;
      for (const decision of decisions)
        if (decision.state === "conflicted")
          wanted.set(`${keyPrefix(projectId)}${decisionRef(decision)}`, flagText(decision));
    }
    const prefixes = Array.from(loaded.keys(), keyPrefix);

    const open = yield* attention.listOpen({ pluginId: PLUGIN_ID, kind: FLAG_KIND });
    const gone = open.filter(
      (flag) =>
        !wanted.has(flag.threadId) && prefixes.some((prefix) => flag.threadId.startsWith(prefix)),
    );
    // New flags and open ones whose decision was renamed.
    const stale = [...wanted].filter(
      ([key, text]) => open.find((flag) => flag.threadId === key)?.text !== text,
    );

    if (!input.dryRun) {
      for (const { threadId } of gone)
        yield* attention.clear({ pluginId: PLUGIN_ID, threadId, kind: FLAG_KIND });
      for (const [threadId, text] of stale)
        yield* attention.raise({
          pluginId: PLUGIN_ID,
          threadId,
          kind: FLAG_KIND,
          text,
          resumeAction: RESUME_ACTION,
        });
    }

    return {
      examined,
      acted: input.dryRun ? 0 : gone.length + stale.length,
      flags: wanted.size,
    };
  });
});

/** Registers the sweep with the supervisor; called from the plugin's layer. */
export const register = Effect.gen(function* () {
  const supervisor = yield* PluginSupervisor.PluginSupervisor;
  const run = yield* sweep;
  yield* supervisor.register({ plugin: PLUGIN_ID, name: "decisions", run });
});
