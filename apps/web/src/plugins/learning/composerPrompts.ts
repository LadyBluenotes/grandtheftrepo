import { executeAtomQuery, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId, Prompt, PromptSummary } from "@t3tools/contracts";
import { useMemo } from "react";

import { toastManager } from "~/components/ui/toast";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useEnvironmentQuery } from "~/state/query";
import { activePromptsAtom, promptDetailAtom, promptUse, refreshPromptLists } from "./promptState";

/**
 * A saved prompt in the composer's `/` menu. Picking it loads its latest body into the message;
 * nothing runs.
 */
export interface SavedPromptComposerItem {
  readonly id: string;
  readonly type: "saved-prompt";
  readonly environmentId: EnvironmentId;
  readonly prompt: PromptSummary;
  readonly label: string;
  readonly description: string;
}

/** How long a pick waits for the prompt's body before giving up. */
const PICK_TIMEOUT_MS = 10_000;

const newerFirst = (a: string | null, b: string | null) =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? 1 : -1;

const mostUsedFirst = (a: PromptSummary, b: PromptSummary) =>
  b.useCount - a.useCount ||
  newerFirst(a.lastUsedAt, b.lastUsedAt) ||
  a.title.localeCompare(b.title) ||
  a.id - b.id;

const firstLine = (text: string) =>
  (text.split("\n").find((line) => line.trim() !== "") ?? "").trim();

/**
 * The menu's saved prompts from the project's active ones: those whose title holds every word of
 * `query` in any case, the most used first. A `/` query is one token, so `-` and `_` in it
 * separate words.
 */
export function savedPromptMenuItems(
  environmentId: EnvironmentId,
  prompts: ReadonlyArray<PromptSummary>,
  query: string,
): SavedPromptComposerItem[] {
  const words = query
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter((word) => word !== "");
  return prompts
    .filter((prompt) => {
      const title = prompt.title.toLowerCase();
      return words.every((word) => title.includes(word));
    })
    .toSorted(mostUsedFirst)
    .map((prompt) => ({
      id: `saved-prompt:${prompt.id}`,
      type: "saved-prompt" as const,
      environmentId,
      prompt,
      label: prompt.title,
      description: firstLine(prompt.preview),
    }));
}

/**
 * `items` followed by the project's matching active prompts while `trigger` is a `/` command. The
 * list is read when the menu opens, again once it is stale or the window regains focus, and kept
 * while the query changes, which only narrows it here. With the learning plugin off, or a server
 * without it, the read fails and nothing is added.
 */
export function useSavedPromptMenuItems<T>(
  items: T[],
  context: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId | null;
    readonly trigger: { readonly kind: string; readonly query: string } | null;
  },
): Array<T | SavedPromptComposerItem> {
  const { environmentId, projectId } = context;
  const query = context.trigger?.kind === "slash-command" ? context.trigger.query : null;
  const prompts = useEnvironmentQuery(
    query === null || projectId === null ? null : activePromptsAtom({ environmentId, projectId }),
  );
  return useMemo(() => {
    if (query === null || prompts.data === null) return items;
    const saved = savedPromptMenuItems(environmentId, prompts.data, query);
    return saved.length === 0 ? items : [...items, ...saved];
  }, [environmentId, items, prompts.data, query]);
}

/**
 * Loads the picked prompt's latest version and hands its body to `insert`, which puts it in the
 * draft keyed `draftKey` in place of the `/` query and says whether it did. When the load fails or
 * the prompt is no longer active, nothing is inserted and the query stays.
 */
export async function pickSavedPrompt(
  item: SavedPromptComposerItem,
  draftKey: string,
  insert: (body: string) => boolean,
): Promise<void> {
  const { environmentId } = item;
  const result = await executeAtomQuery(
    appAtomRegistry,
    promptDetailAtom(environmentId, item.prompt.id),
    { refresh: true, reportFailure: false, signal: AbortSignal.timeout(PICK_TIMEOUT_MS) },
  );
  if (result._tag !== "Success") {
    toastManager.add({ type: "error", title: `Could not load "${item.prompt.title}"` });
    return;
  }
  const { prompt } = result.value;
  if (prompt.state !== "active") {
    // The menu's list predates the change, so re-read it.
    refreshPromptLists({ environmentId, projectId: prompt.projectId });
    toastManager.add({ type: "warning", title: `"${prompt.title}" is ${prompt.state} now` });
    return;
  }
  if (insert(prompt.body)) noteSavedPromptInserted(draftKey, environmentId, prompt);
}

interface PromptPick {
  readonly environmentId: EnvironmentId;
  readonly prompt: Prompt;
}

/** The prompts picked into each composer draft since its last send, by draft key. Memory only. */
const picksByDraft = new Map<string, ReadonlyArray<PromptPick>>();

/** Remembers that `prompt`'s body, as loaded, went into the draft keyed `draftKey`. */
export function noteSavedPromptInserted(
  draftKey: string,
  environmentId: EnvironmentId,
  prompt: Prompt,
): void {
  const picks = picksByDraft.get(draftKey) ?? [];
  picksByDraft.set(draftKey, [
    ...picks.filter((pick) => pick.prompt.id !== prompt.id),
    { environmentId, prompt },
  ]);
}

const collapseWhitespace = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * The draft's picks whose inserted body `message` still holds, comparing runs of whitespace as one
 * space, and forgets them all: a send ends the draft. A body edited before sending is not counted.
 */
export function takeSentPrompts(draftKey: string, message: string): ReadonlyArray<PromptPick> {
  const picks = picksByDraft.get(draftKey);
  if (picks === undefined) return [];
  picksByDraft.delete(draftKey);
  const sent = collapseWhitespace(message);
  return picks.filter((pick) => sent.includes(collapseWhitespace(pick.prompt.body)));
}

/**
 * Counts one use of each saved prompt the sent message holds, then re-reads the project's lists so
 * the menu's order and the Prompts tab follow. Without the operate grant or the plugin it fails
 * quietly.
 */
export function countSavedPromptUses(draftKey: string, message: string): void {
  for (const { environmentId, prompt } of takeSentPrompts(draftKey, message)) {
    void runAtomCommand(
      appAtomRegistry,
      promptUse,
      { environmentId, input: { id: prompt.id } },
      { reportFailure: false },
    ).then((result) => {
      if (result._tag === "Success") {
        refreshPromptLists({ environmentId, projectId: prompt.projectId });
      }
    });
  }
}
