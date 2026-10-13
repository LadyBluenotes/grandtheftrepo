import { assert, it } from "@effect/vitest";

import { stripUnservedToolOutputImageBytes } from "../../orchestration-v2/toolOutputImageBytes.ts";
import * as Fixtures from "./eventFixtures.ts";
import { outputTokens } from "./outputTokens.ts";

const jsonTokens = (value: unknown) => Math.ceil(JSON.stringify(value).length / 4);

/** Base64 of `bytes` bytes, long enough that ingestion treats it as a picture and not an id. */
const base64Of = (bytes: number) => Buffer.alloc(bytes, 7).toString("base64");

/** What ingestion stores for an output: the item the reactor sees, not the one the provider sent. */
const persisted = (output: unknown) => {
  const item = stripUnservedToolOutputImageBytes({ ...Fixtures.mcpItem, output });
  return item.type === "dynamic_tool" ? item.output : undefined;
};

it("counts a string by its characters over four, rounded up, and nothing as zero", () => {
  assert.strictEqual(outputTokens("abcd"), 1);
  assert.strictEqual(outputTokens("abcde"), 2);
  assert.strictEqual(outputTokens(""), 0);
  assert.strictEqual(outputTokens(undefined), 0);
  assert.strictEqual(outputTokens(null), 0);
});

it("counts anything else by its JSON", () => {
  const output = { files: ["a.ts", "b.ts"], truncated: false };
  assert.strictEqual(outputTokens(output), jsonTokens(output));
  assert.strictEqual(outputTokens([]), 1);
});

it("counts an inline image of 200,000 characters as 1,500 plus the text around it", () => {
  const text = { type: "text", text: "Screenshot taken." };
  const output = {
    content: [text, { type: "image", mimeType: "image/png", data: "A".repeat(200_000) }],
  };
  // The image's bytes and its block are not text; what is left is the text block.
  assert.strictEqual(outputTokens(output), 1500 + jsonTokens({ content: [text] }));
});

it("counts the placeholder ingestion leaves for an image as the image it was", () => {
  const text = { type: "text", text: "Screenshot taken." };
  const placeholder = { type: "image", mimeType: "image/png", sizeBytes: 3_000_000 };
  assert.strictEqual(
    outputTokens({ content: [text, placeholder] }),
    1500 + jsonTokens({ content: [text] }),
  );
  assert.strictEqual(outputTokens(placeholder), 1500);
});

it("counts every image of a stored output, not only the first eight an asset can serve", () => {
  const text = { type: "text", text: "Frames." };
  const frames = Array.from({ length: 12 }, () => ({
    type: "image",
    data: base64Of(3_000),
    mimeType: "image/png",
  }));
  const output = { content: [text, ...frames] };
  const stored = persisted(output);

  // The ninth frame on has no bytes left: only a size.
  assert.deepEqual((stored as { content: ReadonlyArray<unknown> }).content[9], {
    type: "image",
    mimeType: "image/png",
    sizeBytes: 3_000,
  });
  assert.strictEqual(outputTokens(stored), 12 * 1500 + jsonTokens({ content: [text] }));
  // Sizing the output as the provider sent it and as it was stored gives one answer.
  assert.strictEqual(outputTokens(output), outputTokens(stored));
});

it("counts an oversized image, whose bytes ingestion removes from a served position", () => {
  const output = {
    content: [{ type: "image", data: base64Of(40_000_000), mimeType: "image/png" }],
  };
  const stored = persisted(output);
  assert.deepEqual(stored, {
    content: [{ type: "image", mimeType: "image/png", sizeBytes: 40_000_000 }],
  });
  // The image is 1,500; what remains is the empty list it came out of.
  assert.strictEqual(outputTokens(stored), 1500 + jsonTokens({ content: [] }));
});

it("sizes every shape of image alike before and after ingestion, whatever else the output says", () => {
  const png = base64Of(3_000);
  const shapes: ReadonlyArray<readonly [string, unknown, number]> = [
    ["an MCP block", { content: [{ type: "image", data: png, mimeType: "image/png" }] }, 1],
    [
      "Anthropic's base64 source",
      [{ type: "image", source: { type: "base64", media_type: "image/png", data: png } }],
      1,
    ],
    [
      "Claude's structured Read result",
      { type: "image", file: { base64: png, type: "image/png", originalSize: 3_000 } },
      1,
    ],
    [
      "Grok's ImageContent",
      { rawOutput: { type: "ReadFile", ImageContent: { data: png, mime_type: "image/png" } } },
      1,
    ],
    [
      "a Cursor image part",
      { content: [{ text: { text: "captured" } }, { image: { data: png } }] },
      1,
    ],
    [
      "images inside an error",
      { error: "partial", result: [{ type: "image", data: png, mimeType: "image/png" }] },
      1,
    ],
  ];
  for (const [name, shape, images] of shapes) {
    // Alone, an image may sit where an asset serves it and keep its bytes; nested in a result it
    // never does, so ingestion replaces its bytes with a size.
    for (const output of [shape, { nested: shape }]) {
      const stored = persisted(output);
      assert.strictEqual(outputTokens(stored), outputTokens(output), name);
      const bare = outputTokens(output) - images * 1500;
      assert.isBelow(bare, 20, `${name} leaves only its non-image text`);
    }
    assert.notDeepEqual(persisted({ nested: shape }), { nested: shape }, `${name} kept its bytes`);
  }
});

it("leaves an output without images as it is, and counts inline SVG and ids as text", () => {
  const svg = {
    type: "image",
    mimeType: "image/svg+xml",
    data: `<svg xmlns='http://www.w3.org/2000/svg'>${"<circle r='4'/>".repeat(8)}</svg>`,
  };
  const byId = { type: "image", data: "asset-id-42" };
  const remote = { type: "image", source: { type: "url", url: "https://example.test/shot.png" } };
  const output = { content: [svg, byId, remote] };
  assert.strictEqual(outputTokens(output), jsonTokens(output));
});
