import {
  knowledgePagePath,
  type KnowledgeVerifyResult,
  type PolicyAgent,
} from "@t3tools/contracts";

import { blockMarkers, sha256, type FoundBlock } from "../InstructionBlocks.ts";

/** The instruction file each agent reads in a project, relative to its root. */
export const PROJECT_INSTRUCTION_FILES = {
  claude: "CLAUDE.md",
  codex: "AGENTS.md",
  copilot: ".github/copilot-instructions.md",
} as const satisfies Record<PolicyAgent, string>;

/** The index block, the same in every instruction file. */
export const INDEX_MARKERS = blockMarkers("knowledge", "index");

/** The text that cannot appear in a title, which the index block carries. */
export const MARKER_WORD = "fork-knowledge:";

const INDEX_LEAD = "Before changing code, read the knowledge page below that matches the task.";

export interface Rendered {
  /** Every accepted page's file, in key order. */
  readonly pages: ReadonlyArray<{ readonly path: string; readonly text: string }>;
  /** The index block; undefined when no page is accepted, and then no file carries one. */
  readonly block: { readonly text: string; readonly hash: string } | undefined;
  /** sha256 of everything an install writes, recorded per agent so the sweep sees a change. */
  readonly hash: string;
}

/** What the accepted pages render to: each page with its title as the heading, and the index. */
export const render = (
  accepted: ReadonlyArray<{ readonly key: string; readonly title: string; readonly body: string }>,
): Rendered => {
  const sorted = accepted.toSorted((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const pages = sorted.map((page) => ({
    path: knowledgePagePath(page.key),
    text: `# ${page.title}\n\n${page.body.trim()}\n`,
  }));
  const content =
    sorted.length === 0
      ? undefined
      : `${INDEX_LEAD}\n\n${sorted.map((page) => `- ${knowledgePagePath(page.key)}: ${page.title}`).join("\n")}\n`;
  return {
    pages,
    block:
      content === undefined
        ? undefined
        : {
            text: `${INDEX_MARKERS.start}\n${content}${INDEX_MARKERS.end}`,
            hash: sha256(content),
          },
    hash: sha256([content ?? "", ...pages.map((page) => `${page.path}\n${page.text}`)].join("\0")),
  };
};

/**
 * Whether one agent in use needs an install: its recorded delivery is of another render or
 * another file, or it has none while there is an index to deliver.
 */
export const needsInstall = (input: {
  readonly rendered: Rendered;
  /** The agent's instruction file in the project today. */
  readonly path: string;
  readonly delivery: { readonly hash: string; readonly path: string } | undefined;
}) =>
  input.delivery === undefined
    ? input.rendered.block !== undefined
    : input.delivery.hash !== input.rendered.hash || input.delivery.path !== input.path;

type Status = KnowledgeVerifyResult["status"];

/** The index block a file holds against the one the accepted pages render to, if any. */
export const blockStatus = (expectedHash: string | undefined, found: FoundBlock): Status => {
  if (expectedHash === undefined) return found.kind === "absent" ? "ok" : "drifted";
  if (found.kind === "absent") return "missing";
  return found.kind === "found" && found.hash === expectedHash ? "ok" : "drifted";
};

/** One page file against its rendered text; undefined when there is no file. */
export const pageStatus = (text: string | undefined, expected: string): Status =>
  text === undefined ? "missing" : text === expected ? "ok" : "drifted";

const RANK: Record<Status, number> = { ok: 0, drifted: 1, missing: 2 };

/** The worse of two: something gone outranks something changed. */
export const worse = (a: Status, b: Status): Status => (RANK[b] > RANK[a] ? b : a);
