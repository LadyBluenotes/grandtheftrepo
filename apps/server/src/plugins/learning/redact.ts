import { redactSecrets } from "../redactSecrets.ts";

/** Longest description stored: what a correction says, not a transcript. */
export const DESCRIPTION_LIMIT = 500;

/** Replaces what looks like a secret with `[redacted]`, then truncates to `DESCRIPTION_LIMIT` characters. */
export function redact(text: string): string {
  const clean = redactSecrets(text);
  return clean.length <= DESCRIPTION_LIMIT ? clean : clean.slice(0, DESCRIPTION_LIMIT);
}
