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
      tier: "standard" as const,
      criteria: [{ id: "c1", text: "Redirect lands on the requested page", checked: false }],
      blocked: {
        reason: "Need a TTL decision",
        at: "2026-10-12T14:03:00.000Z",
        by: "thread:thr_1",
      },
      reopened: { reason: "defect" as const, at: "2026-10-12T14:10:00.000Z", by: "user" },
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
    assert.strictEqual(parsed?.issue.tier, null);
    assert.deepStrictEqual(parsed?.issue.criteria, []);
    assert.strictEqual(parsed?.issue.reopened, null);
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
        state: "accepted" as const,
        title: "Keep session TTL at 30m",
        why: "Extending it hides the bug.",
        alternatives: [
          {
            title: "Keep 30m",
            disposition: "chosen" as const,
            reason: "Matches the IdP.",
            reasonKind: "contextual" as const,
          },
          {
            title: "Extend to 24h",
            disposition: "rejected" as const,
            reason: "Hides the redirect bug.",
            reasonKind: "permanent" as const,
          },
        ],
        reconsiderWhen: "The IdP session length changes.",
        supersedes: ["auth/short-ttl"],
        supersededBy: null,
        issues: ["fix-login-redirect"],
        threads: [ThreadId.make("thr_1")],
        by: "user",
        at: "2026-10-12T14:00:00.000Z",
        revisions: [{ at: "2026-10-12T14:00:00.000Z", by: "user", change: "created: accepted" }],
      },
    ];
    const text = serializeDecisions("auth", "grandtheftrepo", decisions);
    assert.deepStrictEqual(parseDecisions("auth", text), decisions);
    assert.strictEqual(parseDecisions("auth", "decisions: [not: valid"), null);
  });

  it("reads a decision written with a stance as accepted, with its title as the one alternative", () => {
    const legacy = [
      "category: auth",
      "project: grandtheftrepo",
      "decisions:",
      "  - id: keep-ttl",
      "    stance: for",
      "    title: Keep session TTL at 30m",
      "    why: Extending it hides the bug.",
      "    issues: [fix-login-redirect]",
      "    by: user",
      '    at: "2026-10-12T14:00:00.000Z"',
      "  - id: retries-on-login",
      "    stance: against",
      "    title: Retries on login",
      '    why: ""',
      "    issues: []",
      "    by: thread:thr_1",
      '    at: "2026-10-12T15:00:00.000Z"',
      "",
    ].join("\n");
    const parsed = parseDecisions("auth", legacy);
    const common = {
      category: "auth",
      state: "accepted" as const,
      reconsiderWhen: null,
      supersedes: [],
      supersededBy: null,
      threads: [],
      revisions: [],
    };
    assert.deepStrictEqual(parsed, [
      {
        ...common,
        id: "keep-ttl",
        title: "Keep session TTL at 30m",
        why: "Extending it hides the bug.",
        alternatives: [
          {
            title: "Keep session TTL at 30m",
            disposition: "chosen",
            reason: "Extending it hides the bug.",
            reasonKind: "contextual",
          },
        ],
        issues: ["fix-login-redirect"],
        by: "user",
        at: "2026-10-12T14:00:00.000Z",
      },
      {
        ...common,
        id: "retries-on-login",
        title: "Retries on login",
        why: "",
        alternatives: [
          {
            title: "Retries on login",
            disposition: "rejected",
            reason: "",
            reasonKind: "contextual",
          },
        ],
        issues: [],
        by: "thread:thr_1",
        at: "2026-10-12T15:00:00.000Z",
      },
    ]);
    // Written back in the new shape, it reads the same and carries no stance.
    const saved = serializeDecisions("auth", "grandtheftrepo", parsed ?? []);
    assert.notMatch(saved, /stance/);
    assert.match(saved, /^ {4}state: accepted$/m);
    assert.deepStrictEqual(parseDecisions("auth", saved), parsed);
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
