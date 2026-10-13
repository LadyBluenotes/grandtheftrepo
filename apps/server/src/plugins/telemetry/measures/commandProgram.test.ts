import { assert, it } from "@effect/vitest";

import { programName } from "./commandProgram.ts";

/** Cases taken from the client's `commandProgramName` tests, for the rules this file copies. */
const named = (cases: ReadonlyArray<readonly [string, string | null]>) => {
  for (const [command, program] of cases) {
    assert.strictEqual(programName(command), program, command);
  }
};

it("names the program with its directory dropped", () => {
  named([
    ["vp test run", "vp"],
    ["/usr/bin/git status", "git"],
    ["$HOME/.bun/bin/bun test", "bun"],
    ['"C:\\Program Files\\nodejs\\node.exe" script.js', "node.exe"],
    ["/bin/zsh", "zsh"],
  ]);
});

it("unwraps a shell's -c and -lc script, nested ones and the wrappers around it", () => {
  named([
    ["/bin/zsh -lc 'git diff --check'", "git"],
    ['/bin/zsh -lc "npx -y react-doctor@latest apps/web"', "npx"],
    ["/bin/bash --noprofile --norc -l -c 'sed -n 1,270p file.ts'", "sed"],
    ["/bin/bash -o pipefail -lc 'vp test run'", "vp"],
    ["sh -ec 'node scripts/check.js'", "node"],
    ["bash -lc \"zsh -c 'git status'\"", "git"],
    ["zsh -lc 'CI=1 env -u DEBUG sudo -u root vp test run'", "vp"],
    ["env CI=1 /bin/zsh -lc '\"/Applications/My Tools/bin/check\" --verbose'", "check"],
    ["/bin/zsh -lc 'git status\nsed -n 1,20p file.ts'", "git"],
  ]);
});

it("keeps a shell that runs no script as the program", () => {
  named([
    ["bash -l", "bash"],
    ["zsh script.sh -c 'git status'", "zsh"],
    ["bash -- -c 'git status'", "bash"],
    ["my-shell -c 'git status'", "my-shell"],
  ]);
});

it("keeps the first program of a compound command, and looks past setup commands", () => {
  named([
    ["vp test && git status", "vp"],
    ["vp test || git status", "vp"],
    ["rg needle src | head", "rg"],
    ["vp test; git status", "vp"],
    ["vp test &", "vp"],
    ["cd packages/client-runtime && vp test run", "vp"],
    ['cd "a path with spaces"; git status', "git"],
    ["cd apps/web\npnpm test", "pnpm"],
    ["CI=1 cd apps/web && npm test", "npm"],
    ["cd /tmp 2>&1 && npm test", "npm"],
    ["cd /tmp &>/dev/null && bun test", "bun"],
    ["cd $(find . -type d | head -1) && git status", "git"],
    ["cd ${ROOT:-path;with;semicolons} && bun test", "bun"],
    ["cd /tmp \\\n&& npm test", "npm"],
    ["export CI=1 && cd apps/web && pnpm test", "pnpm"],
    ["set -eu; npm test", "npm"],
    ["test -d node_modules || vp i", "vp"],
    ["# use the workspace\nnpm test", "npm"],
  ]);
});

it("does not read a program out of quotes, substitutions or arguments", () => {
  named([
    ["printf '%s\\n' 'a;b|c'", "printf"],
    ["echo '$(git status)'", "echo"],
    ['echo "$(git status)"', "echo"],
    ["echo `git status`", "echo"],
    ["cat <(rg needle src)", "cat"],
    ['rg -n "if|for|while" src', "rg"],
  ]);
});

it("unwraps env, sudo, timeout and the other wrappers that run what follows", () => {
  named([
    ["sudo -u root pnpm test", "pnpm"],
    ["env CI=1 npm test", "npm"],
    ["timeout 10 pnpm test", "pnpm"],
    ["nohup npx expo start >/tmp/metro.log 2>&1 &", "npx"],
    ["command git status", "git"],
    ["exec node app.js", "node"],
    ["time -p deno test", "deno"],
    ["sudo -n true && npm test", "npm"],
  ]);
});

it("names nothing when no program names the command", () => {
  named([
    ["", null],
    ["zsh -lc", null],
    ["cd packages/client-runtime", null],
    ["export NODE_ENV=test", null],
    ["if test -f package.json; then vp test; fi", null],
    ['for file in *; do echo "$file"; done', null],
    ["$PY scripts/check.py", null],
    ["${TOOL} --version", null],
    ["command -v git", null],
    ["# comment only", null],
    ["(vp test)", null],
  ]);
});

it("follows nested shell scripts only so far", () => {
  assert.strictEqual(programName("sh -c 'git status'", 3), "git");
  assert.strictEqual(programName("sh -c 'git status'", 4), null);
});

it("groups what the client parser follows beyond POSIX under the wrapper or the first word", () => {
  assert.deepEqual(
    [
      "cmd /c cd C:\\work && npm test",
      'pwsh -Command "npm test"',
      "powershell -NoProfile -Command npm test",
      "ll -la",
      "cat <<EOF\nhello\nEOF",
      "npm test > out.txt",
      "> out.txt echo hi",
    ].map((command) => programName(command)),
    ["cmd", "pwsh", "powershell", "ll", "cat", "npm", null],
  );
});
