import {
  KNOWLEDGE_BODY_MAX_LENGTH,
  KNOWLEDGE_MARKER_WORD,
  KNOWLEDGE_TITLE_MAX_LENGTH,
  MAX_SCRIPT_ID_LENGTH,
  PROMPT_BODY_MAX_LENGTH,
  PROMPT_TITLE_MAX_LENGTH,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type ProjectScript,
  type TelemetryExtractionCandidate,
  type TelemetryExtractionForm,
} from "@t3tools/contracts";

/*
 * The text of each draft the weekly review proposes, from the candidate alone. A candidate never
 * carries a script's text, only its program and digest, so a script step becomes a line naming the
 * program and the example item to copy it from. Telemetry bounds a command's head but not a
 * dynamic tool's path, pattern or input keys, so every field is cut to fit its target's contract.
 */

const COMMAND = "command:";
const SCRIPT = /^script:([^:]*):(.*)$/;
/** The most of one step a draft's text quotes; the proposal keeps every step whole. */
const STEP_MAX = 300;
/** Titles for a scheduled task and a card, which their schemas do not bound. */
const SHORT_TITLE_MAX = 120;
/** Keys and ids made from the candidate's id; a knowledge key is at most 64 characters. */
const KEY_PREFIX = "repeated-";
const KNOWLEDGE_KEY_MAX = 64;
const SCRIPT_ID_PART_MAX = 12;

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** A step as a person reads it: a command without its `command:` prefix, never empty. */
const stepText = (step: string) => {
  if (!step.startsWith(COMMAND)) return step;
  const command = step.slice(COMMAND.length);
  return command.trim() === "" ? "(empty command)" : command;
};

/** The steps on one line, at most `max` characters. */
const summary = (steps: ReadonlyArray<string>, max: number) =>
  clip(oneLine(steps.map(stepText).join(" → ")), max);

/** The candidate's id as lowercase letters, digits and hyphens, at most `max` characters. */
const idPart = (candidate: TelemetryExtractionCandidate, max: number) =>
  candidate.id
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, max) || "candidate";

/** One line naming the repeated work, as lists show it. */
export const proposalTitle = (candidate: TelemetryExtractionCandidate) =>
  summary(candidate.steps, 160);

const stepsBlock = (steps: ReadonlyArray<string>) =>
  ["```text", ...steps.map((step) => clip(oneLine(stepText(step)), STEP_MAX)), "```"].join("\n");

const lookAt = (candidate: TelemetryExtractionCandidate) =>
  `One run to look at: thread ${candidate.example.threadId}.`;

const evidence = (candidate: TelemetryExtractionCandidate, week: string) =>
  `Agents in this project repeated this in ${candidate.threads} threads, ${candidate.occurrences} times, about ${candidate.estimatedTokens} estimated tokens in the week from ${week.slice(0, 10)}.`;

/** Paragraphs as one markdown body of at most `max` characters. */
const body = (parts: ReadonlyArray<string>, max: number) => clip(parts.join("\n\n"), max);

/**
 * A draft project script: each command step's shape on a line, `<str>` and `<n>` still marking the
 * strings and numbers that varied. A script step is a comment naming its program and the example
 * item to copy it from, and so is a command recorded with no text, so the command is never empty.
 * Never run until a person edits and accepts it.
 */
export const scriptDraft = (candidate: TelemetryExtractionCandidate): ProjectScript => {
  const where = (index: number) =>
    `item ${candidate.example.itemIds[index] ?? candidate.example.itemIds[0] ?? ""} in thread ${candidate.example.threadId}`;
  const lines = candidate.steps.map((step, index) => {
    const script = SCRIPT.exec(step);
    if (script !== null) return `# Paste the ${script[1]} script from ${where(index)} here.`;
    const command = (step.startsWith(COMMAND) ? step.slice(COMMAND.length) : step).trim();
    return command === "" ? `# A command with no text was recorded; see ${where(index)}.` : command;
  });
  return {
    id: `${KEY_PREFIX}${idPart(candidate, Math.min(SCRIPT_ID_PART_MAX, MAX_SCRIPT_ID_LENGTH - KEY_PREFIX.length))}`,
    name: clip(`Repeated: ${summary(candidate.steps.slice(0, 1), 60)}`, 60),
    command: lines.length === 0 ? "# No steps were recorded." : lines.join("\n"),
    icon: "play",
    runOnWorktreeCreate: false,
  };
};

/** A proposed workflow for the prompt library. */
export const promptDraft = (candidate: TelemetryExtractionCandidate, week: string) => ({
  kind: "workflow" as const,
  title: clip(
    `Repeated: ${summary(candidate.steps, PROMPT_TITLE_MAX_LENGTH)}`,
    PROMPT_TITLE_MAX_LENGTH,
  ),
  body: body(
    [
      evidence(candidate, week),
      stepsBlock(candidate.steps),
      "`<path>` and `<pattern>` mark what changed between runs. Write down what the steps are for and how to do them in one go, then accept the prompt so agents follow it instead.",
      lookAt(candidate),
    ],
    PROMPT_BODY_MAX_LENGTH,
  ),
});

/** Text without the knowledge index block's marker, which a page title cannot hold. */
const withoutMarker = (text: string) => {
  let rest = text;
  while (rest.includes(KNOWLEDGE_MARKER_WORD)) rest = rest.replaceAll(KNOWLEDGE_MARKER_WORD, "");
  return rest;
};

/** A knowledge draft keyed by the candidate, so a second proposal of it finds the first. */
export const knowledgeDraft = (candidate: TelemetryExtractionCandidate, week: string) => ({
  key: `${KEY_PREFIX}${idPart(candidate, KNOWLEDGE_KEY_MAX - KEY_PREFIX.length)}`,
  title: clip(
    oneLine(
      withoutMarker(
        `What runs read first: ${summary(candidate.steps, KNOWLEDGE_TITLE_MAX_LENGTH)}`,
      ),
    ),
    KNOWLEDGE_TITLE_MAX_LENGTH,
  ),
  body: body(
    [
      evidence(candidate, week),
      "Most runs start with these reads:",
      stepsBlock(candidate.steps),
      "Replace this with the facts agents look for there, so they can start without the reads.",
      lookAt(candidate),
    ],
    KNOWLEDGE_BODY_MAX_LENGTH,
  ),
});

/** A scheduled task's title and prompt; the task is saved paused. */
export const taskDraft = (candidate: TelemetryExtractionCandidate, week: string) => ({
  title: clip(`Repeated: ${summary(candidate.steps, 100)}`, SHORT_TITLE_MAX),
  prompt: body(
    [
      evidence(candidate, week),
      "Run these steps and report what changed since the last run:",
      stepsBlock(candidate.steps),
    ],
    PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ),
});

const NEEDS_CODE: Partial<Record<TelemetryExtractionForm, string>> = {
  hook: "a hook the provider runs after an edit",
  mcp_tool: "one MCP tool that returns what these reads and searches gather",
};

/** The label a Triage card for work that needs code carries. */
export const CARD_LABEL = "deterministic";

/**
 * A Triage card for a form that needs code written. Its description ends with `marker`, which
 * names the proposal, so a retry finds the card it filed.
 */
export const cardDraft = (
  candidate: TelemetryExtractionCandidate,
  week: string,
  proposalId: number,
) => {
  const marker = `Proposal ${proposalId} on the Learning screen's Deterministic tab.`;
  return {
    title: clip(`Could be deterministic: ${summary(candidate.steps, 100)}`, SHORT_TITLE_MAX),
    description: [
      `${evidence(candidate, week)} It could be ${NEEDS_CODE[candidate.form] ?? "code"}.`,
      stepsBlock(candidate.steps),
      `${lookAt(candidate)} ${marker}`,
    ].join("\n\n"),
    marker,
  };
};
