import { useAtomValue } from "@effect/atom-react";
import {
  createPluginRpcCommand,
  createPluginRpcQueryAtomFamily,
} from "@t3tools/client-runtime/plugins/rpc";
import {
  POLICY_METHODS,
  PolicyError,
  type PolicyAcceptInput,
  type PolicyAgent,
  type PolicyAgentsInput,
  type PolicyCreateInput,
  type PolicyInstallResult,
  type PolicyListing,
  type PolicyState,
  type PolicyVerifyResult,
  type PolicyVersion,
  type PolicyVersionRef,
  type ProjectId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "~/connection/runtime";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { usePluginEnvironmentId } from "../pluginState";

/**
 * A scope's policies with the environment's beside them. Nothing pushes a change, so the list
 * re-reads when the window comes back into view and after each command here; it never polls.
 */
const policyList = createPluginRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:plugins:policy",
  method: POLICY_METHODS.list,
  staleTimeMs: 5_000,
  refreshTrigger: () => Atom.windowFocusSignal,
});

const policyCreate = createPluginRpcCommand(connectionAtomRuntime, {
  label: "policy:create",
  method: POLICY_METHODS.create,
});

const policyAccept = createPluginRpcCommand(connectionAtomRuntime, {
  label: "policy:accept",
  method: POLICY_METHODS.accept,
});

const policyInstall = createPluginRpcCommand(connectionAtomRuntime, {
  label: "policy:install",
  method: POLICY_METHODS.install,
});

/** The policies `scope` can see on the Plugins page's environment: its own and the environment's. */
export function usePolicyList(scope: ProjectId) {
  const environmentId = usePluginEnvironmentId();
  return useEnvironmentQuery(
    environmentId === null ? null : policyList({ environmentId, input: { projectId: scope } }),
  );
}

const notConnected = <A>() =>
  Promise.resolve(
    AsyncResult.failure<A, PolicyError>(
      Cause.fail(new PolicyError({ code: "inactive", message: "No environment is connected." })),
    ),
  );

/** Writes to the Plugins page's environment; `canWrite` follows the operate grant every method needs. */
export function usePolicyCommands() {
  const environmentId = usePluginEnvironmentId();
  const runCreate = useAtomCommand(policyCreate, { reportFailure: false });
  const runAccept = useAtomCommand(policyAccept, { reportFailure: false });
  const runInstall = useAtomCommand(policyInstall, { reportFailure: false });
  const canWrite = useAtomValue(policyCreate.permissionAtom(environmentId));
  return {
    canWrite,
    create: (input: PolicyCreateInput) =>
      environmentId === null
        ? notConnected<PolicyVersionRef>()
        : runCreate({ environmentId, input }),
    accept: (input: PolicyAcceptInput) =>
      environmentId === null
        ? notConnected<PolicyVersionRef>()
        : runAccept({ environmentId, input }),
    install: (input: PolicyAgentsInput) =>
      environmentId === null
        ? notConnected<ReadonlyArray<PolicyInstallResult>>()
        : runInstall({ environmentId, input }),
  };
}

/** The scope's own policies, the last changed first; the environment's stay out of a project's list. */
export function scopePolicies(
  listings: ReadonlyArray<PolicyListing>,
  scope: ProjectId,
): ReadonlyArray<PolicyListing> {
  return listings
    .filter((policy) => policy.projectId === scope)
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.key.localeCompare(b.key));
}

/** The newest draft above the shown version, waiting to be accepted; null when there is none. */
export function pendingDraft(
  policy: Pick<PolicyListing, "version" | "versions">,
): PolicyVersion | null {
  const drafts = policy.versions.filter(
    (version) => version.state === "draft" && version.version > policy.version,
  );
  return drafts.at(-1) ?? null;
}

/** A policy's versions, newest first. */
export function versionsNewestFirst(
  policy: Pick<PolicyListing, "versions">,
): ReadonlyArray<PolicyVersion> {
  return policy.versions.toSorted((a, b) => b.version - a.version);
}

/** Only an accepted version installs; a draft or a superseded one cannot be delivered. */
export const canInstall = (policy: Pick<PolicyListing, "state">) => policy.state === "accepted";

export const STATE_BADGE: Record<
  PolicyState,
  { readonly label: string; readonly variant: "success" | "warning" | "secondary" }
> = {
  accepted: { label: "Accepted", variant: "success" },
  draft: { label: "Draft", variant: "warning" },
  superseded: { label: "Superseded", variant: "secondary" },
};

export const DELIVERY_BADGE: Record<
  PolicyVerifyResult["status"],
  { readonly label: string; readonly variant: "success" | "warning" | "error" }
> = {
  ok: { label: "OK", variant: "success" },
  drifted: { label: "Drifted", variant: "warning" },
  missing: { label: "Missing", variant: "error" },
};

export const AGENT_LABEL: Record<PolicyAgent, string> = {
  claude: "Claude Code",
  codex: "Codex",
  copilot: "Copilot",
};

const isKey = (value: string) => /^[a-z0-9-]+$/.test(value);

/**
 * Why a new policy's form cannot save yet, or null when it can: the key must match the server's
 * pattern and not name a policy the scope already has.
 */
export function newPolicyProblem(
  key: string,
  title: string,
  existing: ReadonlyArray<Pick<PolicyListing, "key">>,
): string | null {
  if (key.length === 0) return "A key is needed.";
  if (!isKey(key)) return "A key is lowercase letters, digits and dashes.";
  if (existing.some((policy) => policy.key === key)) return `"${key}" already exists here.`;
  if (title.trim().length === 0) return "A title is needed.";
  return null;
}
