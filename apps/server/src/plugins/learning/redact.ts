/** Longest description stored: what a correction says, not a transcript. */
export const DESCRIPTION_LIMIT = 500;

const SECRET_PATTERNS: ReadonlyArray<readonly [pattern: RegExp, replacement: string]> = [
  // `Authorization: Bearer ...`, whatever follows to the end of the line.
  [/\b(authorization\s*[:=]\s*)[^\r\n]+/gi, "$1[redacted]"],
  // `API_KEY=...`, `token=...`, `client_secret=...`.
  [/\b(\w*(?:key|token|secret))(\s*=\s*)\S+/gi, "$1$2[redacted]"],
  // GitHub, OpenAI, Slack and AWS token prefixes.
  [/\b(?:ghp_|github_pat_|sk-|xoxb-|AKIA)[\w-]+/g, "[redacted]"],
];

/** Replaces what looks like a secret with `[redacted]`, then truncates to `DESCRIPTION_LIMIT` characters. */
export function redact(text: string): string {
  const clean = SECRET_PATTERNS.reduce(
    (current, [pattern, replacement]) => current.replaceAll(pattern, replacement),
    text,
  );
  return clean.length <= DESCRIPTION_LIMIT ? clean : clean.slice(0, DESCRIPTION_LIMIT);
}
