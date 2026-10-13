import { omitToolOutputImageData, toolOutputImages } from "@t3tools/shared/toolOutput";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** What one image in a tool result costs, whatever its size: a screenshot is not its base64. */
const IMAGE_TOKENS = 1500;

const encodeJson = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/**
 * The estimated tokens of a tool result: its characters over four, rounded up, with a string
 * counted as it is and anything else as its JSON. Each inline image is `IMAGE_TOKENS` and its
 * bytes are left out of the text. There is no tokenizer here and providers report usage per turn,
 * so this is a size, not a bill. An item with no output is zero.
 */
export const outputTokens = (output: unknown) => {
  if (output === undefined || output === null) return 0;
  if (typeof output === "string") return Math.ceil(output.length / 4);
  const images = toolOutputImages(output).filter((image) => image.data !== undefined).length;
  const text = Option.getOrElse(
    encodeJson(images === 0 ? output : omitToolOutputImageData(output)),
    () => "",
  );
  return images * IMAGE_TOKENS + Math.ceil(text.length / 4);
};
