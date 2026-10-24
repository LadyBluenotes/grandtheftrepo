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

const INDEX_LEAD = "Before changing code, read the knowledge page below that matches the task.";

export interface Rendered {
  /** Every accepted page's file, in key order, with the sha256 of its text. */
  readonly pages: ReadonlyArray<{
    readonly key: string;
    readonly path: string;
    readonly text: string;
    readonly hash: string;
  }>;
  /** The index block; undefined when no page is accepted, and then no file carries one. */
  readonly block: { readonly text: string; readonly hash: string } | undefined;
}

/**
 * What the accepted pages render to: each page with its title as the heading, and the index.
 * `pagePath` names a page's file as the index lists it; by default a path in the project, and a
 * folder of the project's own gives an absolute one.
 */
export const render = (
  accepted: ReadonlyArray<{ readonly key: string; readonly title: string; readonly body: string }>,
  pagePath: (key: string) => string = knowledgePagePath,
): Rendered => {
  const sorted = accepted.toSorted((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const content =
    sorted.length === 0
      ? undefined
      : `${INDEX_LEAD}\n\n${sorted.map((page) => `- ${pagePath(page.key)}: ${page.title}`).join("\n")}\n`;
  return {
    pages: sorted.map((page) => {
      const text = `# ${page.title}\n\n${page.body.trim()}\n`;
      return { key: page.key, path: pagePath(page.key), text, hash: sha256(text) };
    }),
    block:
      content === undefined
        ? undefined
        : {
            text: `${INDEX_MARKERS.start}\n${content}${INDEX_MARKERS.end}`,
            hash: sha256(content),
          },
  };
};

/**
 * What the sweep does with one thing an install records, a page file or an agent's index block:
 * nothing, record what is already there, write it, or leave it for a person.
 */
export type CatchUp = "none" | "record" | "write" | "leave";

/**
 * The sweep's decision for one component. `expected` is the hash it renders to now (undefined when
 * it should not exist), `current` the hash it holds now (undefined when absent), and `delivery` what
 * the last install recorded. A stale component is written only while it still holds what was
 * recorded; one holding anything else was edited by hand, and stays drifted until a person
 * reinstalls.
 */
export const catchUp = (input: {
  readonly expected: string | undefined;
  readonly current: string | undefined;
  readonly path: string;
  readonly delivery: { readonly hash: string; readonly path: string } | undefined;
}): CatchUp => {
  const { expected, current, delivery } = input;
  const stale =
    delivery === undefined
      ? expected !== undefined
      : delivery.hash !== expected || delivery.path !== input.path;
  if (!stale) return "none";
  if (current === expected) return "record";
  if (delivery !== undefined && current !== delivery.hash) return "leave";
  return "write";
};

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
