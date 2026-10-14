import * as Schema from "effect/Schema";
import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "../baseSchemas.ts";
import { definePluginMethods } from "./method.ts";
import { PolicyAgent } from "./policy.ts";

/** Where a project's accepted pages live, relative to its root. The one place it is named. */
export const KNOWLEDGE_DIRECTORY = ".knowledge";

/** A page's path relative to the project root, as the index block lists it by default. */
export const knowledgePagePath = (key: string) => `${KNOWLEDGE_DIRECTORY}/${key}.md`;

/** A page's file name under the project's knowledge directory, without `.md`; unique per project among pages not retired. */
export const KnowledgeKey = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/),
);
export type KnowledgeKey = typeof KnowledgeKey.Type;

/** Text a title cannot hold: the index block it is listed in is marked with it. */
export const KNOWLEDGE_MARKER_WORD = "fork-knowledge:";

/**
 * One line: it is the page's heading and its line in the index block, so it cannot hold the
 * block's marker text. A body never enters the block and may.
 */
export const KNOWLEDGE_TITLE_MAX_LENGTH = 200;
export const KnowledgeTitle = TrimmedNonEmptyString.check(
  Schema.isMaxLength(KNOWLEDGE_TITLE_MAX_LENGTH),
  Schema.isPattern(/^[^\r\n]*$/),
  Schema.makeFilter((title) =>
    title.includes(KNOWLEDGE_MARKER_WORD)
      ? `A title cannot contain "${KNOWLEDGE_MARKER_WORD}", which marks the index block.`
      : true,
  ),
);

export const KNOWLEDGE_BODY_MAX_LENGTH = 4_000;
/** Markdown. */
export const KnowledgeBody = TrimmedNonEmptyString.check(
  Schema.isMaxLength(KNOWLEDGE_BODY_MAX_LENGTH),
);

/** A draft is never written to the project; an accepted page is; a retired one is removed. */
export const KnowledgeState = Schema.Literals(["draft", "accepted", "retired"]);
export type KnowledgeState = typeof KnowledgeState.Type;

/** Who proposed the page: an agent's thread, a learning item's promotion, or a person. */
export const KnowledgeSource = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("agent"), threadId: ThreadId }),
  Schema.Struct({ kind: Schema.Literal("item"), itemId: Schema.Int, promotionId: Schema.Int }),
  Schema.Struct({ kind: Schema.Literal("person") }),
]);
export type KnowledgeSource = typeof KnowledgeSource.Type;

export const KnowledgeEntry = Schema.Struct({
  id: Schema.Int,
  projectId: ProjectId,
  key: KnowledgeKey,
  title: Schema.String,
  body: Schema.String,
  state: KnowledgeState,
  source: KnowledgeSource,
  createdAt: IsoDateTime,
  acceptedAt: Schema.NullOr(IsoDateTime),
  retiredAt: Schema.NullOr(IsoDateTime),
});
export type KnowledgeEntry = typeof KnowledgeEntry.Type;

export const KnowledgeListInput = Schema.Struct({
  projectId: ProjectId,
  state: Schema.optional(KnowledgeState),
});
export type KnowledgeListInput = typeof KnowledgeListInput.Type;

export const KnowledgeProposeInput = Schema.Struct({
  projectId: ProjectId,
  key: KnowledgeKey,
  title: KnowledgeTitle,
  body: KnowledgeBody,
});
export type KnowledgeProposeInput = typeof KnowledgeProposeInput.Type;

/** Accepts a draft, with the title or body replaced when given. */
export const KnowledgeAcceptInput = Schema.Struct({
  id: Schema.Int,
  title: Schema.optional(KnowledgeTitle),
  body: Schema.optional(KnowledgeBody),
});
export type KnowledgeAcceptInput = typeof KnowledgeAcceptInput.Type;

/** One page, by id: an accepted page to retire, or a draft to discard. */
export const KnowledgeIdInput = Schema.Struct({ id: Schema.Int });
export type KnowledgeIdInput = typeof KnowledgeIdInput.Type;

export const KnowledgeProjectInput = Schema.Struct({ projectId: ProjectId });
export type KnowledgeProjectInput = typeof KnowledgeProjectInput.Type;

/**
 * Where a project's pages are written, on the machine the server runs on; null is the project's
 * own `.knowledge` directory. It is an absolute path, checked by the server, on one line because
 * the index block lists each page by it.
 */
export const KnowledgeLocation = Schema.Struct({
  projectId: ProjectId,
  directory: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isPattern(/^[^\r\n]*$/))),
});
export type KnowledgeLocation = typeof KnowledgeLocation.Type;

/** One agent in use: its instruction file in the project, and whether this install changed it. */
export const KnowledgeInstallResult = Schema.Struct({
  agent: PolicyAgent,
  status: Schema.Literals(["installed", "unchanged"]),
  path: Schema.String,
});
export type KnowledgeInstallResult = typeof KnowledgeInstallResult.Type;

/**
 * One agent in use. `missing` when its instruction file, the index block or an accepted page is
 * gone; `drifted` when one of them differs from what the accepted pages render to.
 */
export const KnowledgeVerifyResult = Schema.Struct({
  agent: PolicyAgent,
  status: Schema.Literals(["ok", "drifted", "missing"]),
  path: Schema.String,
});
export type KnowledgeVerifyResult = typeof KnowledgeVerifyResult.Type;

export class KnowledgeError extends Schema.TaggedError<KnowledgeError>()("KnowledgeError", {
  code: Schema.Literals(["inactive", "not_found", "invalid", "io"]),
  message: Schema.String,
}) {}

/**
 * Agents and people propose; accepting, retiring, discarding and installing are a person's
 * decision about the project and need settings access.
 */
export const KNOWLEDGE_METHODS = definePluginMethods({
  list: {
    method: "knowledge.list",
    gateway: "read",
    input: KnowledgeListInput,
    output: Schema.Array(KnowledgeEntry),
    error: KnowledgeError,
  },
  propose: {
    method: "knowledge.propose",
    gateway: "operate",
    input: KnowledgeProposeInput,
    output: KnowledgeEntry,
    error: KnowledgeError,
  },
  accept: {
    method: "knowledge.accept",
    gateway: "settingsWrite",
    input: KnowledgeAcceptInput,
    output: KnowledgeEntry,
    error: KnowledgeError,
  },
  /** Only an accepted page; its file and index line go on the install that follows. */
  retire: {
    method: "knowledge.retire",
    gateway: "settingsWrite",
    input: KnowledgeIdInput,
    output: KnowledgeEntry,
    error: KnowledgeError,
  },
  /** Only a draft, which was never written; it is kept as retired so it can be proposed again. */
  discard: {
    method: "knowledge.discard",
    gateway: "settingsWrite",
    input: KnowledgeIdInput,
    output: KnowledgeEntry,
    error: KnowledgeError,
  },
  install: {
    method: "knowledge.install",
    gateway: "settingsWrite",
    input: KnowledgeProjectInput,
    output: Schema.Array(KnowledgeInstallResult),
    error: KnowledgeError,
  },
  location: {
    method: "knowledge.location",
    gateway: "read",
    input: KnowledgeProjectInput,
    output: KnowledgeLocation,
    error: KnowledgeError,
  },
  /**
   * Moves where the project's pages are written, then installs there. Files already written in the
   * old place are left as they are.
   */
  setLocation: {
    method: "knowledge.setLocation",
    gateway: "settingsWrite",
    input: KnowledgeLocation,
    output: KnowledgeLocation,
    error: KnowledgeError,
  },
  verify: {
    method: "knowledge.verify",
    gateway: "read",
    input: KnowledgeProjectInput,
    output: Schema.Array(KnowledgeVerifyResult),
    error: KnowledgeError,
  },
});
