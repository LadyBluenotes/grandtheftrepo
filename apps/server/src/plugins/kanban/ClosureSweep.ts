import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as Attention from "../Attention.ts";
import * as PluginSupervisor from "../PluginSupervisor.ts";
import * as KanbanStore from "./KanbanStore.ts";

const PLUGIN_ID = "kanban";
const FLAG_KIND = "closure_held";
const RESUME_ACTION = { label: "Open board", target: "board" } as const;
const PREFIX = "closure:";

/** The project id sits between colons, so the project's board and report list the flag. */
const keyOf = (projectId: ProjectId, issueId: string) => `${PREFIX}${projectId}:${issueId}`;

const isProjectId = Schema.is(ProjectId);

/** The project and issue a key names; an issue id is a slug, so it holds no colon. */
const parseKey = (key: string) => {
  const projectId = key.slice(PREFIX.length, key.lastIndexOf(":"));
  return key.startsWith(PREFIX) && isProjectId(projectId)
    ? { projectId, id: key.slice(key.lastIndexOf(":") + 1) }
    : null;
};

const flagText = (held: KanbanStore.Held) =>
  `"${held.title}" (${held.id}) was not moved to Done: ${held.missing.join("; ")}.`;

/**
 * Raises one `closure_held` flag per card auto-advance held back from Done, keyed by its project
 * and issue; holding it again rewrites the same flag.
 */
export const hold = Effect.gen(function* () {
  const attention = yield* Attention.Attention;
  return (projectId: ProjectId, held: ReadonlyArray<KanbanStore.Held>) =>
    Effect.forEach(
      held,
      (card) =>
        attention.raise({
          pluginId: PLUGIN_ID,
          threadId: keyOf(projectId, card.id),
          kind: FLAG_KIND,
          text: flagText(card),
          resumeAction: RESUME_ACTION,
        }),
      { discard: true },
    );
});

/**
 * Builds the closure sweep. It clears each open `closure_held` flag once its card passes the
 * closure check, reaches Done, is archived or is gone, and rewrites its text while what the card
 * lacks changes. A card it cannot read for another reason keeps its flag. A dry run reads no
 * card, since reading one loads its project, which creates folders and watchers and archives old
 * cards; it counts the open flags as they are and writes nothing.
 */
export const sweep = Effect.gen(function* () {
  const store = yield* KanbanStore.KanbanStore;
  const attention = yield* Attention.Attention;

  /**
   * The text a card's flag should carry while the card is held, null once the flag should go, and
   * undefined when the card cannot be read: then the flag is left as it is.
   */
  const wanted = (projectId: ProjectId, id: string) =>
    Effect.all([
      store.getIssue({ projectId, id }),
      store.listDecisions({ projectId, issue: id }),
    ]).pipe(
      Effect.map(([issue, decisions]) => {
        const missing =
          issue.status === "done" || issue.archivedAt !== null
            ? []
            : KanbanStore.closureGaps(issue, decisions);
        return missing.length === 0 ? null : flagText({ id, title: issue.title, missing });
      }),
      // A card or project that is gone takes its flag with it.
      Effect.catch((error) => Effect.succeed(error.code === "not_found" ? null : undefined)),
    );

  return Effect.fn("ClosureSweep.run")(function* (input: { readonly dryRun: boolean }) {
    const open = yield* attention.listOpen({ pluginId: PLUGIN_ID, kind: FLAG_KIND });
    if (input.dryRun) return { examined: open.length, acted: 0, flags: open.length };
    const gone: Array<string> = [];
    const stale: Array<readonly [string, string]> = [];
    for (const flag of open) {
      const key = parseKey(flag.threadId);
      if (key === null) continue;
      const text = yield* wanted(key.projectId, key.id);
      if (text === null) gone.push(flag.threadId);
      else if (text !== undefined && text !== flag.text) stale.push([flag.threadId, text]);
    }

    for (const threadId of gone)
      yield* attention.clear({ pluginId: PLUGIN_ID, threadId, kind: FLAG_KIND });
    for (const [threadId, text] of stale)
      yield* attention.raise({
        pluginId: PLUGIN_ID,
        threadId,
        kind: FLAG_KIND,
        text,
        resumeAction: RESUME_ACTION,
      });

    return {
      examined: open.length,
      acted: gone.length + stale.length,
      flags: open.length - gone.length,
    };
  });
});

/** Registers the sweep with the supervisor; called from the plugin's layer. */
export const register = Effect.gen(function* () {
  const supervisor = yield* PluginSupervisor.PluginSupervisor;
  const run = yield* sweep;
  yield* supervisor.register({ plugin: PLUGIN_ID, name: "closure", run });
});
