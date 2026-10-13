/*
 * A POSIX subset of `commandProgramName` in `packages/client-runtime/src/work-log/commandLabel.ts`,
 * which names the program a command ran in the work log. The server cannot import that package,
 * so the rules for `sh -c` and `bash -lc` wrappers, `env`, `sudo`, setup builtins, control flow
 * and compound commands are copied, and nothing keeps the two in step. It is not the same parser:
 * the client also follows `cmd /c`, `pwsh -Command` and other PowerShell forms, heredocs, aliases
 * and redirections, and this one does not.
 *
 * The measures group tool output by this name, so the difference only moves a call between
 * buckets: a Windows wrapper groups under the wrapper (`command:cmd`, `command:pwsh`), a heredoc
 * or an alias under its first word (`command:cat`), and a command that begins with a redirection,
 * having no program, under `command:unknown`. Full parity would mean copying or relocating
 * upstream code for a label that only groups costs.
 */

/** Nested `<shell> -c <script>` wrappers followed, and top-level segments looked through. */
const MAX_DEPTH = 4;
const MAX_SEGMENTS = 64;

const words = (list: string) => new Set(list.split(" "));

const SHELLS = words("sh bash zsh dash ash ksh fish");
const SHELL_OPTIONS_WITH_VALUE = words("-o -O --rcfile --init-file");
const ENV_OPTIONS_WITH_VALUE = words("-C --chdir -S --split-string -u --unset");
const SUDO_OPTIONS_WITH_VALUE = words("-C --close-from -D --chdir -g --group -u --user");
/** Programs that run the command after their own options. */
const TRANSPARENT = words("command builtin exec nocorrect noglob time nohup");
/** Shell builtins that set the scene: the label is the next command, as in `cd app && vp test`. */
const SETUP = words(
  "cd export unset set source . : true false test [ [[ alias unalias local declare typeset readonly pushd popd umask ulimit shift shopt setopt unsetopt",
);
/** Control flow, which makes the commands after it conditional: no program names the command. */
const CONTROL = words(
  "if then else elif fi for foreach while until do done case esac select function eval exit return break continue coproc repeat in",
);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const SHELL_COMMAND_OPTION = /^-[a-zA-Z]*c[a-zA-Z]*$/;

/**
 * Splits a command line into the words of each top-level segment, with quotes removed. A segment
 * ends at `;`, `&&`, `||`, `|`, `&` or a newline outside quotes, `$(...)`, `${...}` and backticks.
 * A quote that never closes runs to the end.
 */
const segmentsOf = (command: string) => {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let word = "";
  let inWord = false;
  let nesting = 0;
  let inBackticks = false;
  const endWord = () => {
    if (inWord) tokens.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    const next = command[index + 1];
    if (char === "'") {
      const close = command.indexOf("'", index + 1);
      const end = close === -1 ? command.length : close;
      word += command.slice(index + 1, end);
      inWord = true;
      index = end;
    } else if (char === '"') {
      inWord = true;
      for (index += 1; index < command.length && command[index] !== '"'; index += 1) {
        const escaped = command[index + 1];
        if (command[index] === "\\" && escaped !== undefined && '"\\$`'.includes(escaped)) {
          index += 1;
        }
        word += command[index];
      }
    } else if (char === "\\") {
      if (next !== "\n" && next !== undefined) {
        word += next;
        inWord = true;
      }
      index += 1;
    } else if (char === "`") {
      inBackticks = !inBackticks;
      word += char;
      inWord = true;
    } else if (nesting > 0 || inBackticks) {
      if (char === "(" || char === "{") nesting += 1;
      if ((char === ")" || char === "}") && nesting > 0) nesting -= 1;
      word += char;
    } else if ((char === "$" || char === "<" || char === ">") && next === "(") {
      nesting += 1;
      word += char + next;
      inWord = true;
      index += 1;
    } else if (char === "$" && next === "{") {
      nesting += 1;
      word += char + next;
      inWord = true;
      index += 1;
    } else if (char === " " || char === "\t") {
      endWord();
    } else if (char === "#" && !inWord) {
      const newline = command.indexOf("\n", index);
      index = newline === -1 ? command.length : newline - 1;
    } else if (char === "\n" || char === ";" || char === "|") {
      endSegment();
    } else if (char === "&") {
      // `2>&1`, `<&0` and `&>file` are redirections; any other `&` ends the command.
      const previous = command[index - 1];
      if (next === ">" || previous === ">" || previous === "<") {
        word += char;
        inWord = true;
      } else {
        endSegment();
      }
    } else {
      word += char;
      inWord = true;
    }
  }
  endSegment();
  return segments.slice(0, MAX_SEGMENTS);
};

/** The program a word names with its directory dropped, or null when it is not a literal name. */
const programOf = (word: string) => {
  const name = word.slice(Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\")) + 1);
  return name === "" || /[$`(){}<>%!&*?]/.test(name) ? null : name;
};

/** The index after a wrapper's own options and arguments, where the command it runs starts. */
const afterOptions = (
  tokens: ReadonlyArray<string>,
  from: number,
  withValue: ReadonlySet<string> = new Set(),
) => {
  let index = from;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token === "--") return index + 1;
    if (!token.startsWith("-")) break;
    index += withValue.has(token) ? 2 : 1;
  }
  return index;
};

/** What a segment names: a program, null for a command no program names, or undefined to look on. */
const segmentProgram = (
  tokens: ReadonlyArray<string>,
  depth: number,
): { readonly program: string | null } | undefined => {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (ASSIGNMENT.test(token)) {
      index += 1;
      continue;
    }
    const name = programOf(token);
    if (name === null || CONTROL.has(name)) return { program: null };
    if (SETUP.has(name)) return undefined;
    if (name === "env") {
      index = afterOptions(tokens, index + 1, ENV_OPTIONS_WITH_VALUE);
    } else if (name === "sudo") {
      index = afterOptions(tokens, index + 1, SUDO_OPTIONS_WITH_VALUE);
    } else if (name === "timeout" || name === "gtimeout") {
      index = afterOptions(tokens, index + 1) + 1;
    } else if (TRANSPARENT.has(name)) {
      // `command -v git` looks a program up; it does not run it.
      if (name === "command" && /^-\w*[vV]/.test(tokens[index + 1] ?? "")) return { program: null };
      index = afterOptions(tokens, index + 1);
    } else if (SHELLS.has(name)) {
      return { program: shellScriptProgram(tokens, index, name, depth) };
    } else {
      return { program: name };
    }
  }
  return undefined;
};

/** Where the script of a shell's `-c` option is in `tokens`, or -1 when the shell runs no such script. */
const scriptIndex = (tokens: ReadonlyArray<string>, shell: number) => {
  for (let index = shell + 1; index < tokens.length; index += 1) {
    const option = tokens[index]!;
    if (option === "--" || !option.startsWith("-")) break;
    if (SHELL_OPTIONS_WITH_VALUE.has(option)) {
      index += 1;
    } else if (option === "--command" || SHELL_COMMAND_OPTION.test(option)) {
      return index + 1;
    }
  }
  return -1;
};

/** A shell with `-c` names what its script runs; a shell without it, such as `bash run.sh`, names itself. */
const shellScriptProgram = (
  tokens: ReadonlyArray<string>,
  shell: number,
  name: string,
  depth: number,
) => {
  const index = scriptIndex(tokens, shell);
  if (index === -1) return name;
  const script = tokens[index];
  return script === undefined || depth >= MAX_DEPTH ? null : programName(script, depth + 1);
};

/**
 * The script a command line runs inside its `<shell> -c` wrappers, followed as `programName`
 * follows them: `cd app && git status` for `/bin/bash -lc 'cd app && git status'`. A command line
 * that is not one such wrapper, such as `bash run.sh` or `bash -c x; ls`, is itself.
 */
export const unwrapShell = (command: string, depth = 0): string => {
  const segments = segmentsOf(command);
  const tokens = segments[0];
  if (segments.length !== 1 || tokens === undefined || depth >= MAX_DEPTH) return command;
  const name = programOf(tokens[0]!);
  if (name === null || !SHELLS.has(name)) return command;
  const script = tokens[scriptIndex(tokens, 0)];
  return script === undefined ? command : unwrapShell(script, depth + 1);
};

/**
 * The program a command line runs, such as `git` for `/bin/zsh -lc 'cd app && /usr/bin/git diff'`,
 * or null when no program names it, such as a bare `cd`, a control structure or a variable.
 */
export const programName = (command: string, depth = 0): string | null => {
  for (const tokens of segmentsOf(command)) {
    const found = segmentProgram(tokens, depth);
    if (found !== undefined) return found.program;
  }
  return null;
};
