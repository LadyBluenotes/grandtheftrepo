const SECRET_PATTERNS: ReadonlyArray<readonly [pattern: RegExp, replacement: string]> = [
  // `Authorization: Bearer ...`, whatever follows to the end of the line.
  [/\b(authorization\s*[:=]\s*)[^\r\n]+/gi, "$1[redacted]"],
  // `API_KEY=...`, `token=...`, `client_secret=...`.
  [/\b(\w*(?:key|token|secret))(\s*=\s*)\S+/gi, "$1$2[redacted]"],
  // GitHub, OpenAI, Slack and AWS token prefixes.
  [/\b(?:ghp_|github_pat_|sk-|xoxb-|AKIA)[\w-]+/g, "[redacted]"],
];

/**
 * Replaces what looks like a secret with `[redacted]`. Plugins run text agents wrote, such as a
 * correction's description or a script's command line, through it before a read can return it.
 */
export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce(
    (current, [pattern, replacement]) => current.replaceAll(pattern, replacement),
    text,
  );
}
