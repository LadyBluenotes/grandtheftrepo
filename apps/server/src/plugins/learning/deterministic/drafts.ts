import type {
  ProjectScript,
  TelemetryExtractionCandidate,
  TelemetryExtractionForm,
} from "@t3tools/contracts";

/*
 * The text of each draft the weekly review proposes, from the candidate alone. A candidate never
 * carries a script's text, only its program and digest, so a script step becomes a line naming the
 * program and the example item to copy it from.
 */

const COMMAND = "command:";
const SCRIPT = /^script:([^:]*):(.*)$/;

/** A step as a person reads it: a command without its `command:` prefix. */
const stepText = (step: string) => (step.startsWith(COMMAND) ? step.slice(COMMAND.length) : step);

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** The steps on one line, at most `max` characters. */
const summary = (steps: ReadonlyArray<string>, max: number) =>
  clip(oneLine(steps.map(stepText).join(" → ")), max);

/** One line naming the repeated work, as lists show it. */
export const proposalTitle = (candidate: TelemetryExtractionCandidate) =>
  summary(candidate.steps, 160);

const stepsBlock = (steps: ReadonlyArray<string>) =>
  ["```text", ...steps.map(stepText), "```"].join("\n");

const lookAt = (candidate: TelemetryExtractionCandidate) =>
  `One run to look at: thread ${candidate.example.threadId}.`;

const evidence = (candidate: TelemetryExtractionCandidate, week: string) =>
  `Agents in this project repeated this in ${candidate.threads} threads, ${candidate.occurrences} times, about ${candidate.estimatedTokens} estimated tokens in the week from ${week.slice(0, 10)}.`;

/**
 * A draft project script: each command step's shape on a line, `<str>` and `<n>` still marking the
 * strings and numbers that varied, and each script step a comment naming its program and the
 * example item to copy it from. Never run until a person edits and accepts it.
 */
export const scriptDraft = (candidate: TelemetryExtractionCandidate): ProjectScript => ({
  id: `repeated-${candidate.id.slice(0, 12)}`,
  name: clip(`Repeated: ${summary(candidate.steps.slice(0, 1), 60)}`, 60),
  command: candidate.steps
    .map((step, index) => {
      const script = SCRIPT.exec(step);
      if (script === null) return stepText(step);
      const item = candidate.example.itemIds[index] ?? candidate.example.itemIds[0] ?? "";
      return `# Paste the ${script[1]} script from item ${item} in thread ${candidate.example.threadId} here.`;
    })
    .join("\n"),
  icon: "play",
  runOnWorktreeCreate: false,
});

/** A proposed workflow for the prompt library. */
export const promptDraft = (candidate: TelemetryExtractionCandidate, week: string) => ({
  kind: "workflow" as const,
  title: clip(`Repeated: ${summary(candidate.steps, 180)}`, 200),
  body: [
    evidence(candidate, week),
    stepsBlock(candidate.steps),
    "`<path>` and `<pattern>` mark what changed between runs. Write down what the steps are for and how to do them in one go, then accept the prompt so agents follow it instead.",
    lookAt(candidate),
  ].join("\n\n"),
});

/** A knowledge draft keyed by the candidate, so a second proposal of it finds the first. */
export const knowledgeDraft = (candidate: TelemetryExtractionCandidate, week: string) => ({
  key: `repeated-${candidate.id}`,
  title: clip(`What runs read first: ${summary(candidate.steps, 160)}`, 200),
  body: [
    evidence(candidate, week),
    "Most runs start with these reads:",
    stepsBlock(candidate.steps),
    "Replace this with the facts agents look for there, so they can start without the reads.",
    lookAt(candidate),
  ].join("\n\n"),
});

/** A scheduled task's title and prompt; the task is saved paused. */
export const taskDraft = (candidate: TelemetryExtractionCandidate, week: string) => ({
  title: clip(`Repeated: ${summary(candidate.steps, 100)}`, 120),
  prompt: [
    evidence(candidate, week),
    "Run these steps and report what changed since the last run:",
    stepsBlock(candidate.steps),
  ].join("\n\n"),
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
    title: clip(`Could be deterministic: ${summary(candidate.steps, 100)}`, 120),
    description: [
      `${evidence(candidate, week)} It could be ${NEEDS_CODE[candidate.form] ?? "code"}.`,
      stepsBlock(candidate.steps),
      `${lookAt(candidate)} ${marker}`,
    ].join("\n\n"),
    marker,
  };
};
