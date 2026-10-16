import { useAtomValue } from "@effect/atom-react";
import {
  createPluginRpcCommand,
  createPluginRpcQueryAtomFamily,
} from "@t3tools/client-runtime/plugins/rpc";
import {
  KNOWLEDGE_BODY_MAX_LENGTH,
  KNOWLEDGE_MARKER_WORD,
  KNOWLEDGE_METHODS,
  KnowledgeBody,
  KnowledgeError,
  KnowledgeTitle,
  type KnowledgeAcceptInput,
  type KnowledgeEntry,
  type KnowledgeSource,
  type KnowledgeVerifyResult,
  type PolicyAgent,
  type ProjectId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";

import { connectionAtomRuntime } from "~/connection/runtime";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { usePluginEnvironmentId } from "../pluginState";

const knowledgeList = createPluginRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:plugins:knowledge",
  method: KNOWLEDGE_METHODS.list,
});

const knowledgeVerify = createPluginRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:plugins:knowledge-verify",
  method: KNOWLEDGE_METHODS.verify,
});

const knowledgeLocation = createPluginRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:plugins:knowledge-location",
  method: KNOWLEDGE_METHODS.location,
});

const knowledgeSetLocation = createPluginRpcCommand(connectionAtomRuntime, {
  label: "knowledge:setLocation",
  method: KNOWLEDGE_METHODS.setLocation,
});

const knowledgeAccept = createPluginRpcCommand(connectionAtomRuntime, {
  label: "knowledge:accept",
  method: KNOWLEDGE_METHODS.accept,
});

const knowledgeRetire = createPluginRpcCommand(connectionAtomRuntime, {
  label: "knowledge:retire",
  method: KNOWLEDGE_METHODS.retire,
});

const knowledgeDiscard = createPluginRpcCommand(connectionAtomRuntime, {
  label: "knowledge:discard",
  method: KNOWLEDGE_METHODS.discard,
});

const knowledgeInstall = createPluginRpcCommand(connectionAtomRuntime, {
  label: "knowledge:install",
  method: KNOWLEDGE_METHODS.install,
});

const knowledgePropose = createPluginRpcCommand(connectionAtomRuntime, {
  label: "knowledge:propose",
  method: KNOWLEDGE_METHODS.propose,
});

/** Every page of one project on the plugin's environment, in all states. */
export function useKnowledgeEntries(projectId: ProjectId | null) {
  const environmentId = usePluginEnvironmentId();
  return useEnvironmentQuery(
    environmentId === null || projectId === null
      ? null
      : knowledgeList({ environmentId, input: { projectId } }),
  );
}

/** Whether each agent in use holds what the project's accepted pages render to. */
export function useKnowledgeDelivery(projectId: ProjectId | null) {
  const environmentId = usePluginEnvironmentId();
  return useEnvironmentQuery(
    environmentId === null || projectId === null
      ? null
      : knowledgeVerify({ environmentId, input: { projectId } }),
  );
}

/** Where one project's pages are written; a null directory is the project's own `.knowledge`. */
export function useKnowledgeLocation(projectId: ProjectId | null) {
  const environmentId = usePluginEnvironmentId();
  return useEnvironmentQuery(
    environmentId === null || projectId === null
      ? null
      : knowledgeLocation({ environmentId, input: { projectId } }),
  );
}

const notConnected = () =>
  Promise.resolve(
    AsyncResult.failure(
      Cause.fail(new KnowledgeError({ code: "inactive", message: "No environment is connected." })),
    ),
  );

/**
 * Commands on the plugin's environment. Accepting, retiring, discarding and installing follow the
 * settings grant (`canWrite`); restoring a retired page proposes it again (`canPropose`).
 */
export function useKnowledgeCommands() {
  const environmentId = usePluginEnvironmentId();
  const runAccept = useAtomCommand(knowledgeAccept, { reportFailure: false });
  const runRetire = useAtomCommand(knowledgeRetire, { reportFailure: false });
  const runDiscard = useAtomCommand(knowledgeDiscard, { reportFailure: false });
  const runInstall = useAtomCommand(knowledgeInstall, { reportFailure: false });
  const runSetLocation = useAtomCommand(knowledgeSetLocation, { reportFailure: false });
  const runPropose = useAtomCommand(knowledgePropose, { reportFailure: false });
  const canWrite = useAtomValue(knowledgeAccept.permissionAtom(environmentId));
  const canPropose = useAtomValue(knowledgePropose.permissionAtom(environmentId));
  return {
    canWrite,
    canPropose,
    accept: (input: KnowledgeAcceptInput) =>
      environmentId === null ? notConnected() : runAccept({ environmentId, input }),
    retire: (id: number) =>
      environmentId === null ? notConnected() : runRetire({ environmentId, input: { id } }),
    discard: (id: number) =>
      environmentId === null ? notConnected() : runDiscard({ environmentId, input: { id } }),
    install: (projectId: ProjectId) =>
      environmentId === null ? notConnected() : runInstall({ environmentId, input: { projectId } }),
    setLocation: (projectId: ProjectId, directory: string | null) =>
      environmentId === null
        ? notConnected()
        : runSetLocation({ environmentId, input: { projectId, directory } }),
    restore: (page: KnowledgeEntry) =>
      environmentId === null
        ? notConnected()
        : runPropose({
            environmentId,
            input: {
              projectId: page.projectId,
              key: page.key,
              title: page.title,
              body: page.body,
            },
          }),
  };
}

interface KnowledgeGroups {
  /** Oldest first: the order they came in. */
  readonly drafts: ReadonlyArray<KnowledgeEntry>;
  /** By key: the order of the index block. */
  readonly accepted: ReadonlyArray<KnowledgeEntry>;
  /** Most recently retired first. */
  readonly retired: ReadonlyArray<KnowledgeEntry>;
}

const byString =
  <A>(of: (value: A) => string) =>
  (a: A, b: A) =>
    of(a) < of(b) ? -1 : of(a) > of(b) ? 1 : 0;

/** The project's pages as the screen lists them. */
export function groupKnowledge(entries: ReadonlyArray<KnowledgeEntry>): KnowledgeGroups {
  return {
    drafts: entries
      .filter((entry) => entry.state === "draft")
      .toSorted(byString((entry) => entry.createdAt)),
    accepted: entries
      .filter((entry) => entry.state === "accepted")
      .toSorted(byString((entry) => entry.key)),
    retired: entries
      .filter((entry) => entry.state === "retired")
      .toSorted(byString((entry) => entry.retiredAt ?? ""))
      .toReversed(),
  };
}

/** A retired page can be proposed again only while no draft or accepted page holds its key. */
export const canRestore = (page: Pick<KnowledgeEntry, "key">, groups: KnowledgeGroups) =>
  ![...groups.drafts, ...groups.accepted].some((live) => live.key === page.key);

const isTitle = Schema.is(KnowledgeTitle);
const isBody = Schema.is(KnowledgeBody);

/** Why an edited draft cannot be accepted as it stands, or null when it can. */
export function draftProblem(title: string, body: string): string | null {
  if (title.trim().length === 0) return "The title is empty.";
  if (title.includes(KNOWLEDGE_MARKER_WORD)) {
    return `The title cannot contain "${KNOWLEDGE_MARKER_WORD}".`;
  }
  if (!isTitle(title.trim())) return "The title is one line of at most 200 characters.";
  if (body.trim().length === 0) return "The body is empty.";
  if (!isBody(body.trim())) {
    return `The body is at most ${KNOWLEDGE_BODY_MAX_LENGTH.toLocaleString("en")} characters.`;
  }
  return null;
}

/** Accepts `draft` with the title and body as edited, sending only the ones that changed. */
export function acceptInput(
  draft: Pick<KnowledgeEntry, "id" | "title" | "body">,
  title: string,
  body: string,
): KnowledgeAcceptInput {
  const nextTitle = title.trim();
  const nextBody = body.trim();
  return {
    id: draft.id,
    ...(nextTitle === draft.title ? {} : { title: nextTitle }),
    ...(nextBody === draft.body ? {} : { body: nextBody }),
  };
}

/**
 * Who a draft row says proposed it. A learned draft names its item by number only: the Learning
 * screen opens an item from local state, so its URL has nothing to link to.
 */
export function draftSourceLabel(source: KnowledgeSource): string {
  switch (source.kind) {
    case "agent":
      return "Proposed by an agent";
    case "item":
      return `Learned from item #${source.itemId}`;
    case "person":
      return "Proposed by a person";
  }
}

export const AGENT_LABEL: Record<PolicyAgent, string> = {
  claude: "Claude Code",
  codex: "Codex",
  copilot: "Copilot",
};

interface DeliveryBadge {
  readonly label: string;
  readonly variant: "success" | "warning" | "error";
}

const DELIVERY_BADGE: Record<KnowledgeVerifyResult["status"], DeliveryBadge> = {
  ok: { label: "Up to date", variant: "success" },
  drifted: { label: "Changed by hand", variant: "warning" },
  missing: { label: "Missing", variant: "error" },
};

export const deliveryBadge = (status: KnowledgeVerifyResult["status"]) => DELIVERY_BADGE[status];

/** True when an install would change something for at least one agent in use. */
export const needsInstall = (results: ReadonlyArray<KnowledgeVerifyResult>) =>
  results.some((result) => result.status !== "ok");

/** Why a typed folder cannot be saved, or null when it can; the server holds the final say. */
export function folderProblem(text: string): string | null {
  const folder = text.trim();
  if (folder.length === 0) return "Enter a folder, or use the project's own.";
  if (!/^([/\\]|[A-Za-z]:[/\\])/.test(folder))
    return "Use an absolute path on the server's machine.";
  return null;
}
