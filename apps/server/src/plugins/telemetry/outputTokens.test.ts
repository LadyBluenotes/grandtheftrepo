import { assert, it } from "@effect/vitest";

import { outputTokens } from "./outputTokens.ts";

const jsonTokens = (value: unknown) => Math.ceil(JSON.stringify(value).length / 4);

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
  // What is left once the image's bytes are gone is the block's type and mime type.
  const rest = { content: [text, { type: "image", mimeType: "image/png" }] };
  assert.strictEqual(outputTokens(output), 1500 + jsonTokens(rest));
});

it("counts each image, in the Anthropic source shape too, and ignores a type it does not serve", () => {
  const source = (data: string) => ({
    type: "image",
    source: { type: "base64", media_type: "image/png", data },
  });
  const bare = { type: "image", mimeType: "image/png" };
  assert.strictEqual(
    outputTokens([source("A".repeat(50_000)), source("B".repeat(90_000))]),
    2 * 1500 + jsonTokens([bare, bare]),
  );
  // Only raster types are images the server serves; an SVG stays text.
  const svg = [{ type: "image", mimeType: "image/svg+xml", data: "A".repeat(4000) }];
  assert.strictEqual(outputTokens(svg), jsonTokens(svg));
});
