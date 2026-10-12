import * as NodeCrypto from "node:crypto";

/** The hash form every marker header and delivery row carries. */
export const sha256 = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

/** The id in the markers: the key alone for the environment-wide project `*`. */
export const blockId = (projectId: string, key: string) =>
  projectId === "*" ? key : `${projectId}/${key}`;

const startMarker = (id: string) => `<!-- fork-policy:start key=${id} -->`;
const endMarker = (id: string) => `<!-- fork-policy:end key=${id} -->`;
const HEADER_PREFIX = "<!-- fork-policy hash=";

export interface RenderedBlock {
  readonly text: string;
  /** sha256 of the lines between the header and the end marker. */
  readonly hash: string;
  /** sha256 of the `RULES.md` text the block carries. */
  readonly rulesHash: string;
}

/** Start marker, header, the global rules, a blank line, the policy body, end marker. */
export const renderBlock = (input: {
  readonly id: string;
  readonly rules: string;
  readonly body: string;
  readonly version: number;
}): RenderedBlock => {
  const content = `${input.rules.trimEnd()}\n\n${input.body.trimEnd()}\n`;
  const hash = sha256(content);
  const rulesHash = sha256(input.rules);
  const header = `<!-- fork-policy hash=${hash} rules=${rulesHash} version=${input.version} -->`;
  return {
    text: `${startMarker(input.id)}\n${header}\n${content}${endMarker(input.id)}`,
    hash,
    rulesHash,
  };
};

export type FoundBlock =
  | { readonly kind: "absent" }
  /** One marker alone, duplicates, or the end before the start: only a person can fix it. */
  | { readonly kind: "damaged" }
  | {
      readonly kind: "found";
      /** Offsets of the block in the text: from the start marker to the end of the end marker. */
      readonly start: number;
      readonly end: number;
      /** sha256 of the lines between the header and the end marker, as `renderBlock` hashes them. */
      readonly hash: string;
    };

const count = (text: string, needle: string) => text.split(needle).length - 1;

/** The key's block in `text`, located by its markers. */
export const findBlock = (text: string, id: string): FoundBlock => {
  const start = startMarker(id);
  const end = endMarker(id);
  const starts = count(text, start);
  const ends = count(text, end);
  if (starts === 0 && ends === 0) return { kind: "absent" };
  if (starts !== 1 || ends !== 1) return { kind: "damaged" };
  const from = text.indexOf(start);
  const endAt = text.indexOf(end);
  if (endAt < from) return { kind: "damaged" };
  let inside = text.slice(from + start.length, endAt);
  if (inside.startsWith("\n")) inside = inside.slice(1);
  if (inside.startsWith(HEADER_PREFIX)) {
    const newline = inside.indexOf("\n");
    inside = newline === -1 ? "" : inside.slice(newline + 1);
  }
  return { kind: "found", start: from, end: endAt + end.length, hash: sha256(inside) };
};

/** `text` with `block` in place of the found one, else appended after a blank line. Bytes outside the block never change. */
export const placeBlock = (
  text: string,
  found: Exclude<FoundBlock, { readonly kind: "damaged" }>,
  block: string,
): string => {
  if (found.kind === "found") return text.slice(0, found.start) + block + text.slice(found.end);
  if (text.length === 0) return `${block}\n`;
  const gap = text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  return `${text}${gap}${block}\n`;
};
