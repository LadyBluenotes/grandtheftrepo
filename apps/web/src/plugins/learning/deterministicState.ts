import { useAtomValue } from "@effect/atom-react";
import {
  createPluginRpcCommand,
  createPluginRpcQueryAtomFamily,
} from "@t3tools/client-runtime/plugins/rpc";
import {
  DETERMINISTIC_METHODS,
  type DeterministicDraft,
  type DeterministicProposalState,
  type EnvironmentId,
  type TelemetryExtractionForm,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "~/connection/runtime";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import type { LearningScope } from "./state";

/** The weekly sweep proposes between visits, so the list re-reads when the window regains focus. */
const onWindowFocus = () => Atom.windowFocusSignal;

const proposalList = createPluginRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:plugins:learning:deterministic",
  method: DETERMINISTIC_METHODS.list,
  refreshTrigger: onWindowFocus,
});

const proposalAccept = createPluginRpcCommand(connectionAtomRuntime, {
  label: "learning:deterministic-accept",
  method: DETERMINISTIC_METHODS.accept,
});
const proposalDismiss = createPluginRpcCommand(connectionAtomRuntime, {
  label: "learning:deterministic-dismiss",
  method: DETERMINISTIC_METHODS.dismiss,
});

/** A project's proposals in every state, newest first. */
export function useDeterministicProposals({ environmentId, projectId }: LearningScope) {
  return useEnvironmentQuery(proposalList({ environmentId, input: { projectId } }));
}

/**
 * A person's decisions on `environmentId`'s proposals. Accepting writes project settings, so it
 * needs the settings grant; dismissing needs the operate grant.
 */
export function useDeterministicCommands(environmentId: EnvironmentId) {
  const runAccept = useAtomCommand(proposalAccept, { reportFailure: false });
  const runDismiss = useAtomCommand(proposalDismiss, { reportFailure: false });
  return {
    canAccept: useAtomValue(proposalAccept.permissionAtom(environmentId)),
    canDismiss: useAtomValue(proposalDismiss.permissionAtom(environmentId)),
    accept: (id: number) => runAccept({ environmentId, input: { id } }),
    dismiss: (id: number, reason: string) => runDismiss({ environmentId, input: { id, reason } }),
  };
}

export const PROPOSAL_STATE_LABEL: Record<DeterministicProposalState, string> = {
  waiting: "Waiting",
  pending: "Pending",
  accepted: "Accepted",
  dismissed: "Dismissed",
};
export const PROPOSAL_STATE_VARIANT: Record<
  DeterministicProposalState,
  "info" | "warning" | "success" | "secondary"
> = {
  waiting: "info",
  pending: "warning",
  accepted: "success",
  dismissed: "secondary",
};

export const FORM_LABEL: Record<TelemetryExtractionForm, string> = {
  script: "Script",
  skill: "Prompt",
  context_file: "Knowledge page",
  scheduled_task: "Scheduled task",
  mcp_tool: "MCP tool",
  hook: "Hook",
};

/** What accepting a draft does in its target. */
export const ACCEPT_EFFECT: Record<DeterministicDraft["kind"], string> = {
  script: "Accepting adds this action to the project.",
  prompt: "Accepting makes this proposed prompt active in the library.",
  knowledge: "Accepting writes this page into the project and lists it for agents.",
  scheduled_task: "Accepting turns this paused task on.",
  kanban: "Accepting moves this card from Triage to Todo.",
};

/** A step as a person reads it: a command without its `command:` prefix. */
export const stepText = (step: string) =>
  step.startsWith("command:") ? step.slice("command:".length) : step;
