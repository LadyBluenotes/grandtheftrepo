import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { carriesImage } from "../../orchestration-v2/toolOutputImageBytes.ts";

/** What one image in a tool result costs, whatever its size: a screenshot is not its base64. */
const IMAGE_TOKENS = 1500;

/** As deep as the image stripping at ingestion looks; a deeper record was never stripped. */
const MAX_DEPTH = 32;

const encodeJson = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const REMOVED = Symbol("removed");

/**
 * `value` without its image records, which `found` counts. A record that carries an image is
 * dropped whole, metadata and body, from an array or from the object holding it, and so is a
 * `type: "image"` block around one, such as Anthropic's `source` wrapper. Containers are copied
 * only when something under them changed, so an output without images is not rebuilt.
 */
const withoutImages = (
  value: unknown,
  key: string | undefined,
  found: { images: number },
  depth: number,
): unknown => {
  if (depth > MAX_DEPTH || typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) {
    const kept: unknown[] = [];
    let changed = false;
    for (const entry of value) {
      const next = withoutImages(entry, undefined, found, depth + 1);
      changed ||= next !== entry;
      if (next !== REMOVED) kept.push(next);
    }
    return changed ? kept : value;
  }
  const record = value as Record<string, unknown>;
  if (carriesImage(record, key)) {
    found.images += 1;
    return REMOVED;
  }
  let kept: Record<string, unknown> | undefined;
  let removedImage = false;
  for (const entryKey of Object.keys(record)) {
    const entry = record[entryKey];
    const next = withoutImages(entry, entryKey, found, depth + 1);
    if (next === entry) continue;
    kept ??= { ...record };
    if (next === REMOVED) {
      delete kept[entryKey];
      removedImage = true;
    } else kept[entryKey] = next;
  }
  // The image inside was counted once already.
  if (removedImage && record.type === "image") return REMOVED;
  return kept ?? record;
};

/**
 * The estimated tokens of a tool result: its characters over four, rounded up, with a string
 * counted as it is and anything else as its JSON. Each image record is `IMAGE_TOKENS` and is left
 * out of the text, whether it still holds its base64 body or only the size ingestion left in its
 * place, and however many a result holds. There is no tokenizer here and providers report usage
 * per turn, so this is a size, not a bill. An item with no output is zero.
 */
export const outputTokens = (output: unknown) => {
  if (output === undefined || output === null) return 0;
  if (typeof output === "string") return Math.ceil(output.length / 4);
  const found = { images: 0 };
  const rest = withoutImages(output, undefined, found, 0);
  const text = rest === REMOVED ? "" : Option.getOrElse(encodeJson(rest), () => "");
  return found.images * IMAGE_TOKENS + Math.ceil(text.length / 4);
};
