import * as Schema from "effect/Schema";
import { IsoDateTime, ProjectId, TrimmedNonEmptyString } from "../baseSchemas.ts";
import { LearningError } from "./learning.ts";
import { definePluginMethods } from "./method.ts";

/** A prompt is one message to send; a workflow is steps for an agent to follow in order. */
export const PromptKind = Schema.Literals(["prompt", "workflow"]);
export type PromptKind = typeof PromptKind.Type;

/**
 * Only an active prompt is offered for use. A proposed one waits for a person to accept it, and an
 * archived one is put away until a person unarchives it.
 */
export const PromptState = Schema.Literals(["active", "proposed", "archived"]);
export type PromptState = typeof PromptState.Type;

/**
 * Where a prompt came from: saved in a thread, by a person or an agent working for one; proposed
 * from work agents repeat; or handed over by a learning item.
 */
export const PromptOrigin = Schema.Literals(["user", "repeated_work", "learning"]);
export type PromptOrigin = typeof PromptOrigin.Type;

/** One line, as a menu lists it. */
export const PromptTitle = TrimmedNonEmptyString.check(
  Schema.isMaxLength(200),
  Schema.isPattern(/^[^\r\n]*$/),
);

export const PROMPT_BODY_MAX_LENGTH = 10_000;
/** The text sent, or the steps followed, as markdown. */
export const PromptBody = TrimmedNonEmptyString.check(Schema.isMaxLength(PROMPT_BODY_MAX_LENGTH));

/** A saved prompt or workflow in one project's library, with its latest version's text. */
export const Prompt = Schema.Struct({
  id: Schema.Int,
  projectId: ProjectId,
  kind: PromptKind,
  state: PromptState,
  origin: PromptOrigin,
  title: Schema.String,
  body: Schema.String,
  /** The latest version's number, from 1. */
  version: Schema.Int,
  useCount: Schema.Int,
  lastUsedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  /** When its text or state last changed; a use does not move it. */
  updatedAt: IsoDateTime,
});
export type Prompt = typeof Prompt.Type;

/** One version of a prompt. Versions are append-only; reverting adds a copy of an earlier one. */
export const PromptVersion = Schema.Struct({
  version: Schema.Int,
  title: Schema.String,
  body: Schema.String,
  createdAt: IsoDateTime,
});
export type PromptVersion = typeof PromptVersion.Type;

export const PromptDetail = Schema.Struct({
  prompt: Prompt,
  /** Oldest first. */
  versions: Schema.Array(PromptVersion),
});
export type PromptDetail = typeof PromptDetail.Type;

/** What an agent's search found, and the id a save from that search names. */
export const PromptSearchResult = Schema.Struct({
  searchId: Schema.String,
  prompts: Schema.Array(Prompt),
});
export type PromptSearchResult = typeof PromptSearchResult.Type;

/** A project's prompts, most recently updated first, narrowed to one state when given. */
export const PromptsListInput = Schema.Struct({
  projectId: ProjectId,
  state: Schema.optional(PromptState),
});
export type PromptsListInput = typeof PromptsListInput.Type;

export const PromptIdInput = Schema.Struct({ id: Schema.Int });
export type PromptIdInput = typeof PromptIdInput.Type;

/** A person's save, which is active at once. */
export const PromptsCreateInput = Schema.Struct({
  projectId: ProjectId,
  kind: PromptKind,
  title: PromptTitle,
  body: PromptBody,
});
export type PromptsCreateInput = typeof PromptsCreateInput.Type;

/** The next version's text; the same text as the latest adds none. */
export const PromptsEditInput = Schema.Struct({
  id: Schema.Int,
  title: PromptTitle,
  body: PromptBody,
});
export type PromptsEditInput = typeof PromptsEditInput.Type;

/** Adds a copy of `version` as the next version. */
export const PromptsRevertInput = Schema.Struct({ id: Schema.Int, version: Schema.Int });
export type PromptsRevertInput = typeof PromptsRevertInput.Type;

/**
 * The prompt library lives in the learning plugin, so its methods answer with `LearningError` and
 * are named under `learning.`. Agents search, save proposals and read over MCP; deciding what is in
 * the library is a person's, through these.
 */
export const PROMPT_METHODS = definePluginMethods({
  list: {
    method: "learning.prompts",
    gateway: "read",
    input: PromptsListInput,
    output: Schema.Array(Prompt),
    error: LearningError,
  },
  get: {
    method: "learning.prompt",
    gateway: "read",
    input: PromptIdInput,
    output: PromptDetail,
    error: LearningError,
  },
  create: {
    method: "learning.promptsCreate",
    gateway: "operate",
    input: PromptsCreateInput,
    output: Prompt,
    error: LearningError,
  },
  edit: {
    method: "learning.promptsEdit",
    gateway: "operate",
    input: PromptsEditInput,
    output: Prompt,
    error: LearningError,
  },
  revert: {
    method: "learning.promptsRevert",
    gateway: "operate",
    input: PromptsRevertInput,
    output: Prompt,
    error: LearningError,
  },
  /** Only a proposed prompt. */
  accept: {
    method: "learning.promptsAccept",
    gateway: "operate",
    input: PromptIdInput,
    output: Prompt,
    error: LearningError,
  },
  /** An active or proposed prompt. */
  archive: {
    method: "learning.promptsArchive",
    gateway: "operate",
    input: PromptIdInput,
    output: Prompt,
    error: LearningError,
  },
  /** Back to active once a person accepted or saved it, otherwise back to proposed. */
  unarchive: {
    method: "learning.promptsUnarchive",
    gateway: "operate",
    input: PromptIdInput,
    output: Prompt,
    error: LearningError,
  },
  /** Counts one use, such as a message sent with it, and stamps when. */
  use: {
    method: "learning.promptsUse",
    gateway: "operate",
    input: PromptIdInput,
    output: Prompt,
    error: LearningError,
  },
});
