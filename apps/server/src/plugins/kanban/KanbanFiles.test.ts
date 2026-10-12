import { ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  parseDecisions,
  parseIssue,
  serializeDecisions,
  serializeIssue,
  slugOf,
  uniqueSlug,
} from "./KanbanFiles.ts";

describe("KanbanFiles", () => {
  it("round-trips an issue through markdown with frontmatter and a log", () => {
    const issue = {
      id: "fix-login-redirect",
      title: "Login redirect loops on expired session",
      status: "inbox" as const,
      priority: "p2" as const,
      labels: ["auth", "bug"],
      verification: "partial" as const,
      blocked: {
        reason: "Need a TTL decision",
        at: "2026-10-12T14:03:00.000Z",
        by: "thread:thr_1",
      },
      threads: [{ id: ThreadId.make("thr_1"), linkedAt: "2026-10-12T13:50:00.000Z" }],
      createdAt: "2026-10-12T13:40:00.000Z",
      createdBy: "thread:thr_1",
      updatedAt: "2026-10-12T14:03:00.000Z",
      doneAt: null,
      archivedAt: null,
      description:
        "Steps:\n\n1. Let the cookie expire\n2. Reload\n\n## Not the log\n\nStill description.",
      log: [
        {
          at: "2026-10-12T13:40:00.000Z",
          by: "thread:thr_1",
          kind: "status" as const,
          text: "triage",
        },
        {
          at: "2026-10-12T13:50:00.000Z",
          by: "thread:thr_1",
          kind: "note" as const,
          text: "Reproduced | on main\nsecond line",
        },
        {
          at: "2026-10-12T14:03:00.000Z",
          by: "thread:thr_1",
          kind: "blocked" as const,
          text: "Need a TTL decision",
        },
      ],
    };
    const text = serializeIssue(issue, "grandtheftrepo");
    assert.match(text, /^project: grandtheftrepo$/m);
    const parsed = parseIssue(issue.id, text);
    assert.deepStrictEqual(parsed, { project: "grandtheftrepo", issue });
  });

  it("fills defaults for a hand-written issue and rejects files without frontmatter", () => {
    const minimal = `---\ntitle: Hello\nstatus: todo\ncreatedAt: 2026-10-12T00:00:00.000Z\n---\nBody only.\n`;
    const parsed = parseIssue("hello", minimal);
    assert.strictEqual(parsed?.issue.priority, "p3");
    assert.strictEqual(parsed?.issue.verification, "unverified");
    assert.strictEqual(parsed?.issue.createdBy, "user");
    assert.strictEqual(parsed?.issue.updatedAt, "2026-10-12T00:00:00.000Z");
    assert.deepStrictEqual(parsed?.issue.log, []);
    assert.strictEqual(parsed?.issue.description, "Body only.");
    assert.strictEqual(parseIssue("x", "# just markdown"), null);
    assert.strictEqual(parseIssue("x", "---\ntitle: 1\nstatus: nope\n---\n"), null);
  });

  it("round-trips a decision category file", () => {
    const decisions = [
      {
        category: "auth",
        id: "keep-ttl",
        stance: "for" as const,
        title: "Keep session TTL at 30m",
        why: "Extending it hides the bug.",
        issues: ["fix-login-redirect"],
        by: "user",
        at: "2026-10-12T14:00:00.000Z",
      },
    ];
    const text = serializeDecisions("auth", "grandtheftrepo", decisions);
    assert.deepStrictEqual(parseDecisions("auth", text), decisions);
    assert.strictEqual(parseDecisions("auth", "decisions: [not: valid"), null);
  });

  it("slugs titles and resolves collisions", () => {
    assert.strictEqual(slugOf("  Fix Login → Redirect!! "), "fix-login-redirect");
    assert.strictEqual(slugOf("???"), "untitled");
    const taken = new Set(["a", "a-2"]);
    assert.strictEqual(
      uniqueSlug("a", (s) => taken.has(s)),
      "a-3",
    );
    assert.strictEqual(
      uniqueSlug("b", (s) => taken.has(s)),
      "b",
    );
  });
});
