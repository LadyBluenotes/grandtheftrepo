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

const promptFields = {
  id: Schema.Int,
  projectId: ProjectId,
  kind: PromptKind,
  state: PromptState,
  origin: PromptOrigin,
  /** The latest version's. */
  title: Schema.String,
  /** The latest version's number, from 1. */
  version: Schema.Int,
  useCount: Schema.Int,
  lastUsedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  /** When its text or state last changed; a use does not move it. */
  updatedAt: IsoDateTime,
};

/** A saved prompt or workflow in one project's library, with its latest version's body. */
export const Prompt = Schema.Struct({ ...promptFields, body: Schema.String });
export type Prompt = typeof Prompt.Type;

/** How much of a body a summary carries. */
export const PROMPT_PREVIEW_LENGTH = 200;

/**
 * A prompt as lists and searches show it: the start of its body instead of all of it. The body
 * comes with the prompt itself.
 */
export const PromptSummary = Schema.Struct({ ...promptFields, preview: Schema.String });
export type PromptSummary = typeof PromptSummary.Type;

/**
 * One version of a prompt, with the start of its body as a summary carries it. Versions are
 * append-only and numbered from 1; reverting adds a copy of an earlier one, by its number.
 */
export const PromptVersion = Schema.Struct({
  version: Schema.Int,
  title: Schema.String,
  preview: Schema.String,
  createdAt: IsoDateTime,
});
export type PromptVersion = typeof PromptVersion.Type;

/** The most versions a prompt's detail lists. */
export const PROMPT_VERSIONS_LIMIT = 20;

/**
 * A prompt with its latest body, and its latest `PROMPT_VERSIONS_LIMIT` versions, newest first.
 * The prompt's `version` says how many there are in all.
 */
export const PromptDetail = Schema.Struct({
  prompt: Prompt,
  versions: Schema.Array(PromptVersion),
});
export type PromptDetail = typeof PromptDetail.Type;

/** What an agent's search found, and the id a save from that search names. */
export const PromptSearchResult = Schema.Struct({
  searchId: Schema.String,
  prompts: Schema.Array(PromptSummary),
});
export type PromptSearchResult = typeof PromptSearchResult.Type;

/** The most prompts a list answers with. */
export const PROMPTS_LIST_LIMIT = 100;

/** How many of a query's words a list or search matches on, and how much of each. */
const PROMPT_QUERY_MAX_WORDS = 8;
const PROMPT_QUERY_WORD_MAX_LENGTH = 64;

export const PROMPT_QUERY_MAX_LENGTH = 500;
/** Words to find in a prompt's title or body. */
export const PromptQuery = Schema.String.check(Schema.isMaxLength(PROMPT_QUERY_MAX_LENGTH));

/**
 * The words a query matches on: its first `PROMPT_QUERY_MAX_WORDS` distinct ones, each cut to
 * `PROMPT_QUERY_WORD_MAX_LENGTH` characters, so a long query stays a small condition.
 */
export const promptQueryWords = (query: string): ReadonlyArray<string> =>
  [
    ...new Set(
      query
        .split(/\s+/)
        .filter((word) => word !== "")
        // Matching ignores ASCII case, so `File` and `FILE` are one word here too.
        .map((word) =>
          Array.from(word.replace(/[A-Z]/g, (letter) => letter.toLowerCase()))
            .slice(0, PROMPT_QUERY_WORD_MAX_LENGTH)
            .join(""),
        ),
    ),
  ].slice(0, PROMPT_QUERY_MAX_WORDS);

/**
 * A project's prompts, the most recently updated first, at most `PROMPTS_LIST_LIMIT`. `state`
 * narrows to one state; `query` to those whose title or body holds each of its words, in any case
 * for ASCII letters.
 */
export const PromptsListInput = Schema.Struct({
  projectId: ProjectId,
  state: Schema.optional(PromptState),
  query: Schema.optional(PromptQuery),
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
    output: Schema.Array(PromptSummary),
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
