import type { SecurityPatternId } from "@t3tools/contracts";

/** One pattern matched on one added line: where it matched, never what. */
export interface Match {
  readonly patternId: SecurityPatternId;
  readonly file: string;
  readonly line: number;
}

/** A hunk line as the new file has it, numbered from 1. Removed lines are left out. */
interface HunkLine {
  readonly added: boolean;
  readonly line: number;
  readonly text: string;
}

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The path a `+++ b/<path>` header names, or null for a deleted file. */
const newPath = (header: string) => {
  const path = header.slice(4).split("\t")[0]!.trimEnd();
  return path === "/dev/null" ? null : path.replace(/^"?b\//, "").replace(/"$/, "");
};

/** The hunks of a unified git diff, each with its file's new path and its new-side lines. */
const parseHunks = (diff: string) => {
  const hunks: Array<{ readonly file: string; readonly lines: Array<HunkLine> }> = [];
  let file: string | null = null;
  let current: Array<HunkLine> = [];
  // Lines the open hunk still has on each side, from its header; both zero outside a hunk.
  let oldLeft = 0;
  let newLeft = 0;
  let next = 0;
  for (const raw of diff.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      const mark = raw[0];
      if (mark === "+") {
        current.push({ added: true, line: next++, text: raw.slice(1) });
        newLeft -= 1;
        continue;
      }
      if (mark === "-") {
        oldLeft -= 1;
        continue;
      }
      if (mark === " " || raw === "") {
        current.push({ added: false, line: next++, text: raw.slice(1) });
        oldLeft -= 1;
        newLeft -= 1;
        continue;
      }
      // `\ No newline at end of file`.
      if (mark === "\\") continue;
      oldLeft = 0;
      newLeft = 0;
    }
    if (raw.startsWith("diff --git ")) file = null;
    else if (raw.startsWith("+++ ")) file = newPath(raw);
    else {
      const header = HUNK_HEADER.exec(raw);
      if (header === null || file === null) continue;
      oldLeft = Number(header[1] ?? 1);
      next = Number(header[2]);
      newLeft = Number(header[3] ?? 1);
      current = [];
      hunks.push({ file, lines: current });
    }
  }
  return hunks;
};

const TOKEN = /\bAKIA[0-9A-Z]{16}\b|\bghp_[A-Za-z0-9]{36}\b|\bsk-[A-Za-z0-9_-]{20,}/;
const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;
const EVAL = /\beval\s*\(|\bnew\s+Function\s*\(/;
const FETCHED = /\b(?:fetch|curl|wget)\b/;
/**
 * `sudo` or `env` ahead of the command, by name or path, with its options, the values of the
 * options that take one, and `env`'s `NAME=value` assignments. The first other word is the command.
 */
const WRAPPER = String.raw`(?:[\w.-]*\/)*(?:sudo(?:\s+(?:-[ugCDhprtU]\s+[^\s|]+|-\S+))*|env(?:\s+(?:-[uCS]\s+[^\s|]+|-\S+|\w+=[^\s|]*))*)\s+`;
/** A download piped into `sh`, `bash` or `zsh`, by name or path, through `sudo` or `env` or not. */
const PIPE_TO_SHELL = new RegExp(
  String.raw`\b(?:curl|wget)\b[^|]*\|\s*(?:${WRAPPER})*(?:[\w.-]*\/)*(?:ba|z)?sh\b`,
);
const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const EVENT_EXPRESSION = /\$\{\{\s*github\.event\./;
const RUN_KEY = /^\s*(?:-\s+)?run\s*:/;
const YAML_KEY = /^\s*(?:-\s+)?[\w.-]+\s*:(?:\s|$)/;
const SHELL_CALL = /\b(?:exec|execSync|os\.system)\s*\((.*)/;
const SHELL_TRUE = /\bshell\s*=\s*True\b/;
/** A command put together from parts: a `${}` template, an f-string, or `+`. */
const BUILT_COMMAND = /\$\{|\b[rR]?[fF][rR]?["']|\+/;

const indentOf = (text: string) => text.length - text.trimStart().length;

/**
 * Whether the line at `index` is a `run:` key or may be inside one: the nearest enclosing key above
 * it, by indentation, is `run:`. A line that is itself another key holds that key's value. Only the
 * hunk is visible, so a line whose enclosing key lies above the hunk counts, since an addition deep
 * inside a long `run: |` block has its key far out of the hunk.
 */
const underRun = (lines: ReadonlyArray<HunkLine>, index: number) => {
  const target = lines[index]!.text;
  if (RUN_KEY.test(target)) return true;
  if (YAML_KEY.test(target)) return false;
  let indent = indentOf(target);
  for (let i = index - 1; i >= 0; i--) {
    const text = lines[i]!.text;
    if (text.trim() === "" || text.trimStart().startsWith("#")) continue;
    const depth = indentOf(text);
    if (depth >= indent) continue;
    if (RUN_KEY.test(text)) return true;
    if (YAML_KEY.test(text)) return false;
    // A shallower line of a block scalar; its own enclosing key decides.
    indent = depth;
  }
  return true;
};

const untrustedShell = (text: string) => {
  const call = SHELL_CALL.exec(text);
  return (
    (call !== null && BUILT_COMMAND.test(call[1]!)) ||
    (SHELL_TRUE.test(text) && BUILT_COMMAND.test(text))
  );
};

/**
 * Every pattern match on the lines `diff` adds, at most one per pattern and line. Removed and
 * context lines never match; context only counts as the `fetch` near an added `eval`, which must
 * sit within five lines of it in the same hunk.
 */
export const scan = (diff: string) => {
  const matches: Array<Match> = [];
  for (const { file, lines } of parseHunks(diff)) {
    const workflow = WORKFLOW_FILE.test(file);
    lines.forEach(({ added, line, text }, index) => {
      if (!added) return;
      const found = (patternId: SecurityPatternId) => matches.push({ patternId, file, line });
      if (TOKEN.test(text)) found("secret.token");
      if (PRIVATE_KEY.test(text)) found("secret.private_key");
      if (
        EVAL.test(text) &&
        lines.some((other) => Math.abs(other.line - line) <= 5 && FETCHED.test(other.text))
      ) {
        found("rce.eval_fetched");
      }
      if (PIPE_TO_SHELL.test(text)) found("rce.pipe_to_shell");
      if (workflow && EVENT_EXPRESSION.test(text) && underRun(lines, index)) {
        found("workflow.injection");
      }
      if (untrustedShell(text)) found("shell.untrusted");
    });
  }
  return matches;
};
