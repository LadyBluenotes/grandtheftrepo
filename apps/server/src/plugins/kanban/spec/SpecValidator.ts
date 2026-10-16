/**
 * The spec format and its deterministic check. A spec is markdown with `## Goal`, `## Approach`
 * and `## Acceptance` once each and in that order, optionally followed by `## Out of scope`, and no
 * other headings. Text before the first heading is ignored. The check answers with the first
 * problem it finds, in words a person can act on.
 */

/** What a drafting thread is asked to write, and what a hand-written spec follows. */
export const SPEC_FORMAT = `## Goal
One or two sentences: what is true once this is done.

## Approach
- Two to five list items, one step each.

## Acceptance
- [ ] One checkable sentence per item, at least one.

## Out of scope
Optional, and last when present.`;

const SECTIONS = ["Goal", "Approach", "Acceptance", "Out of scope"] as const;
type Section = (typeof SECTIONS)[number];
const REQUIRED: ReadonlyArray<Section> = ["Goal", "Approach", "Acceptance"];

export type SpecCheck =
  | { readonly valid: true; readonly acceptance: ReadonlyArray<string> }
  | { readonly valid: false; readonly reason: string };

/** An ATX heading: up to three spaces, one to six `#`, then a space or the end of the line. */
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
/** A top-level item starts with at most one space; anything indented further continues one. */
const LIST_ITEM = /^ ?(?:[-*+]|\d{1,9}[.)])[ \t]+\S/;
const CHECKLIST_ITEM = /^ ?-[ \t]+\[ \][ \t]+(\S.*?)[ \t]*$/;
const CONTINUATION = /^(?: {2,}|\t)\S/;

const refuse = (reason: string): SpecCheck => ({ valid: false, reason });

/** Each item's lines, in order. Null when a line is neither an item nor a continuation of one. */
const items = (
  lines: ReadonlyArray<string>,
  start: (line: string) => string | null,
): Array<Array<string>> | null => {
  const found: Array<Array<string>> = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    const first = start(line);
    if (first !== null) found.push([first]);
    else if (CONTINUATION.test(line) && found.length > 0)
      found[found.length - 1]!.push(line.trim());
    else return null;
  }
  return found;
};

export const validateSpec = (text: string): SpecCheck => {
  const bodies = new Map<Section, Array<string>>();
  const order: Array<Section> = [];
  let body: Array<string> | null = null;
  for (const line of text.split(/\r?\n/)) {
    const heading = HEADING.exec(line);
    if (heading === null) {
      body?.push(line);
      continue;
    }
    const name = (heading[2] ?? "").replace(/[ \t]+#+$/, "");
    const section =
      heading[1] === "##"
        ? SECTIONS.find((known) => known.toLowerCase() === name.toLowerCase())
        : undefined;
    if (section === undefined)
      return refuse(
        `Unexpected heading "${line.trim()}". The only sections are Goal, Approach, Acceptance and Out of scope.`,
      );
    if (bodies.has(section)) return refuse(`Duplicate section: ${section}.`);
    body = [];
    bodies.set(section, body);
    order.push(section);
  }

  const missing = REQUIRED.find((section) => !bodies.has(section));
  if (missing !== undefined) return refuse(`Missing section: ${missing}.`);
  for (let index = 1; index < order.length; index += 1) {
    const before = order[index - 1]!;
    const after = order[index]!;
    if (SECTIONS.indexOf(after) < SECTIONS.indexOf(before))
      return refuse(`Sections are out of order: ${before} comes before ${after}.`);
  }

  if (bodies.get("Goal")!.every((line) => line.trim() === "")) return refuse("Goal is empty.");

  const approach = items(bodies.get("Approach")!, (line) => (LIST_ITEM.test(line) ? line : null));
  if (approach === null) return refuse("Approach must be a list, one step per item.");
  if (approach.length < 2)
    return refuse(
      `Approach has ${approach.length} ${approach.length === 1 ? "item" : "items"}; it needs at least 2.`,
    );
  if (approach.length > 5) return refuse(`Approach has ${approach.length} items; the limit is 5.`);

  const acceptance = items(
    bodies.get("Acceptance")!,
    (line) => CHECKLIST_ITEM.exec(line)?.[1] ?? null,
  );
  if (acceptance === null) return refuse('Acceptance must be a checklist of "- [ ]" items.');
  if (acceptance.length === 0)
    return refuse('Acceptance has no items; it needs at least one "- [ ]" item.');

  return { valid: true, acceptance: acceptance.map((lines) => lines.join(" ")) };
};
