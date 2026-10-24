// @effect-diagnostics nodeBuiltinImport:off - a plain sha256 of text; Effect's Crypto has no digest.
import * as NodeCrypto from "node:crypto";

/** The sha256 of a text in hex: equal texts have equal digests, and the text need not be kept. */
export const digest = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
