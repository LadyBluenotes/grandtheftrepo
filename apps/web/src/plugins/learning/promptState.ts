import { useAtomValue } from "@effect/atom-react";
import {
  createPluginRpcCommand,
  createPluginRpcQueryAtomFamily,
} from "@t3tools/client-runtime/plugins/rpc";
import {
  PROMPT_BODY_MAX_LENGTH,
  PROMPT_METHODS,
  PromptBody,
  PromptTitle,
  type EnvironmentId,
  type PromptKind,
  type PromptOrigin,
  type PromptState,
  type PromptsCreateInput,
  type PromptsEditInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "~/connection/runtime";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import type { LearningScope } from "./state";

/** Agents propose prompts between visits, so the lists re-read when the window regains focus. */
const onWindowFocus = () => Atom.windowFocusSignal;

const promptList = createPluginRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:plugins:learning:prompts",
  method: PROMPT_METHODS.list,
  refreshTrigger: onWindowFocus,
});

const promptDetail = createPluginRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:plugins:learning:prompt",
  method: PROMPT_METHODS.get,
  refreshTrigger: onWindowFocus,
});

const promptCreate = createPluginRpcCommand(connectionAtomRuntime, {
  label: "learning:prompt-create",
  method: PROMPT_METHODS.create,
});
const promptEdit = createPluginRpcCommand(connectionAtomRuntime, {
  label: "learning:prompt-edit",
  method: PROMPT_METHODS.edit,
});
const promptRevert = createPluginRpcCommand(connectionAtomRuntime, {
  label: "learning:prompt-revert",
  method: PROMPT_METHODS.revert,
});
const promptAccept = createPluginRpcCommand(connectionAtomRuntime, {
  label: "learning:prompt-accept",
  method: PROMPT_METHODS.accept,
});
const promptArchive = createPluginRpcCommand(connectionAtomRuntime, {
  label: "learning:prompt-archive",
  method: PROMPT_METHODS.archive,
});
const promptUnarchive = createPluginRpcCommand(connectionAtomRuntime, {
  label: "learning:prompt-unarchive",
  method: PROMPT_METHODS.unarchive,
});

/**
 * A project's prompts as summaries, narrowed by state and by the words of `query` on the server,
 * the most recently updated first, at most `PROMPTS_LIST_LIMIT`. A blank query asks for no words.
 */
export function usePrompts(
  { environmentId, projectId }: LearningScope,
  { state, query }: { readonly state: PromptState | null; readonly query: string },
) {
  const trimmed = query.trim();
  return useEnvironmentQuery(
    promptList({
      environmentId,
      input: {
        projectId,
        ...(state === null ? {} : { state }),
        ...(trimmed === "" ? {} : { query: trimmed }),
      },
    }),
  );
}

/** One prompt with its versions; nothing while `id` is null. */
export function usePrompt(environmentId: EnvironmentId, id: number | null) {
  return useEnvironmentQuery(id === null ? null : promptDetail({ environmentId, input: { id } }));
}

/** A person's commands on `environmentId`'s prompt library; every one needs the operate grant. */
export function usePromptCommands(environmentId: EnvironmentId) {
  const runCreate = useAtomCommand(promptCreate, { reportFailure: false });
  const runEdit = useAtomCommand(promptEdit, { reportFailure: false });
  const runRevert = useAtomCommand(promptRevert, { reportFailure: false });
  const runAccept = useAtomCommand(promptAccept, { reportFailure: false });
  const runArchive = useAtomCommand(promptArchive, { reportFailure: false });
  const runUnarchive = useAtomCommand(promptUnarchive, { reportFailure: false });
  const canWrite = useAtomValue(promptCreate.permissionAtom(environmentId));
  return {
    canWrite,
    create: (input: PromptsCreateInput) => runCreate({ environmentId, input }),
    edit: (input: PromptsEditInput) => runEdit({ environmentId, input }),
    revert: (id: number, version: number) => runRevert({ environmentId, input: { id, version } }),
    accept: (id: number) => runAccept({ environmentId, input: { id } }),
    archive: (id: number) => runArchive({ environmentId, input: { id } }),
    unarchive: (id: number) => runUnarchive({ environmentId, input: { id } }),
  };
}

export const PROMPT_STATES = [
  "active",
  "proposed",
  "archived",
] as const satisfies ReadonlyArray<PromptState>;
export const isPromptState = (value: unknown): value is PromptState =>
  (PROMPT_STATES as ReadonlyArray<unknown>).includes(value);
export const PROMPT_STATE_LABEL: Record<PromptState, string> = {
  active: "Active",
  proposed: "Proposed",
  archived: "Archived",
};
export const PROMPT_STATE_VARIANT: Record<PromptState, "success" | "warning" | "secondary"> = {
  active: "success",
  proposed: "warning",
  archived: "secondary",
};

export const PROMPT_KINDS = ["prompt", "workflow"] as const satisfies ReadonlyArray<PromptKind>;
export const isPromptKind = (value: unknown): value is PromptKind =>
  (PROMPT_KINDS as ReadonlyArray<unknown>).includes(value);
export const PROMPT_KIND_LABEL: Record<PromptKind, string> = {
  prompt: "Prompt",
  workflow: "Workflow",
};

export const PROMPT_ORIGIN_LABEL: Record<PromptOrigin, string> = {
  user: "User",
  repeated_work: "Repeated work",
  learning: "Learning",
};

const isTitle = Schema.is(PromptTitle);
const isBody = Schema.is(PromptBody);

/** Why a title and body cannot be saved as they stand, or null when they can. */
export function promptProblem(title: string, body: string): string | null {
  if (title.trim().length === 0) return "The title is empty.";
  if (!isTitle(title.trim())) return "The title is one line of at most 200 characters.";
  if (body.trim().length === 0) return "The body is empty.";
  if (!isBody(body.trim())) {
    return `The body is at most ${PROMPT_BODY_MAX_LENGTH.toLocaleString("en")} characters.`;
  }
  return null;
}
