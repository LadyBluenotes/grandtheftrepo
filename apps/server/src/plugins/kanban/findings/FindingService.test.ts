import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProjectId, ThreadId, type KanbanError, type Project } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../../config.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as KanbanStore from "../KanbanStore.ts";
import * as FindingService from "./FindingService.ts";

const projectId = ProjectId.make("project-1");
const project: Project = {
  id: projectId,
  title: "Grand Theft Repo",
  workspaceRoot: "/unused",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  deletedAt: null,
};
const finder = ThreadId.make("thr_finder");
const other = ThreadId.make("thr_other");

/** A fresh board folder per test. */
const layerTest = FindingService.layer.pipe(
  Layer.provideMerge(KanbanStore.layer),
  Layer.provideMerge(
    Layer.mock(ProjectService.ProjectService)({
      getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
    }),
  ),
  Layer.provideMerge(
    Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-findings-test-" })),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const failure = <A, R>(effect: Effect.Effect<A, KanbanError, R>) =>
  effect.pipe(
    Effect.map(() => "ok"),
    Effect.catch((error) => Effect.succeed(`${error.code}: ${error.message}`)),
  );

const capture = (searchId: string, fields: { title?: string; issueId?: string } = {}) =>
  Effect.flatMap(FindingService.FindingService, (findings) =>
    findings.capture({
      projectId,
      threadId: finder,
      searchId,
      title: fields.title ?? "Retry loop has no backoff",
      evidence: "apps/server/src/retry.ts:12 retries in a tight loop.",
      truthStatus: "reproduced",
      scopeRelation: "pre_existing",
      issueId: fields.issueId,
    }),
  );

const search = (threadId: ThreadId, query = "retry backoff") =>
  Effect.flatMap(FindingService.FindingService, (findings) =>
    findings.search({ projectId, threadId, query }),
  );

describe("FindingService", () => {
  it.effect("refuses a capture without a recent search from the same thread", () =>
    Effect.gen(function* () {
      assert.include(yield* failure(capture("s99")), "invalid: Search first");

      const theirs = yield* search(other);
      assert.include(yield* failure(capture(theirs.searchId)), "invalid: Search first");

      const stale = yield* search(finder);
      yield* TestClock.adjust(`${FindingService.SEARCH_WINDOW_MINUTES + 1} minutes`);
      assert.include(yield* failure(capture(stale.searchId)), "invalid: Search first");

      // A failed capture leaves the search usable; a capture that lands uses it up.
      const fresh = yield* search(finder);
      assert.strictEqual(
        yield* failure(capture(fresh.searchId, { issueId: "nope" })),
        'not_found: No issue "nope".',
      );
      assert.strictEqual(yield* failure(capture(fresh.searchId)), "ok");
      assert.include(yield* failure(capture(fresh.searchId)), "invalid: Search first");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("attaches to the issue named, or opens one Triage issue labeled finding", () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore.KanbanStore;
      const { id: issueId } = yield* store.write(projectId, "user", {
        action: "issue.create",
        title: "Harden the retry helper",
      });

      const attached = yield* capture((yield* search(finder)).searchId, { issueId });
      assert.strictEqual(attached.issueId, issueId);
      assert.strictEqual((yield* store.board(projectId)).issues.length, 1);
      const holder = yield* store.getIssue({ projectId, id: issueId });
      assert.deepStrictEqual(holder.findings, [attached.finding]);
      assert.include(attached.finding, {
        id: "retry-loop-has-no-backoff",
        disposition: "open",
        proposedBy: `thread:${finder}`,
        threadId: finder,
        review: null,
      });
      assert.strictEqual(holder.log.at(-1)?.kind, "finding");

      const opened = yield* capture((yield* search(finder)).searchId);
      const board = yield* store.board(projectId);
      assert.strictEqual(board.issues.length, 2);
      // The same title gets its own finding id, and its own card.
      assert.strictEqual(opened.finding.id, "retry-loop-has-no-backoff-2");
      const card = yield* store.getIssue({ projectId, id: opened.issueId });
      assert.include(card, {
        title: "Retry loop has no backoff",
        status: "triage",
        verification: "verified",
        description: "apps/server/src/retry.ts:12 retries in a tight loop.",
      });
      assert.deepStrictEqual(card.labels, ["finding"]);
      assert.deepStrictEqual(card.findings, [opened.finding]);

      // The finding is in the issue file, the only copy.
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = yield* fs.readFileString(
        path.join(board.directory, "issues", `${opened.issueId}.md`),
      );
      assert.include(file, "id: retry-loop-has-no-backoff-2");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("finds findings and issues by the words of the query, best first", () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore.KanbanStore;
      yield* store.write(projectId, "user", { action: "issue.create", title: "Retry flakes" });
      yield* store.write(projectId, "user", { action: "issue.create", title: "Unrelated" });
      const captured = yield* capture((yield* search(finder)).searchId);

      // A word matches the words it starts, so "back" finds "backoff".
      const found = yield* search(other, "retry back");
      assert.deepStrictEqual(
        found.findings.map(({ finding }) => finding.id),
        [captured.finding.id],
      );
      // The finding's own card matches both words, the other card only one.
      assert.deepStrictEqual(
        found.issues.map((issue) => issue.id),
        [captured.issueId, "retry-flakes"],
      );
      const none = yield* search(other, "unknown words");
      assert.deepStrictEqual([none.findings, none.issues], [[], []]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("refuses the proposer's review; a rejected finding can be reopened", () =>
    Effect.gen(function* () {
      const findings = yield* FindingService.FindingService;
      const store = yield* KanbanStore.KanbanStore;
      const { finding, issueId } = yield* capture((yield* search(finder)).searchId);
      const review = (by: string, disposition: "rejected" | "open") =>
        findings.review({ projectId, id: finding.id, disposition, reason: `${by} says so` }, by);

      assert.include(yield* failure(review(`thread:${finder}`, "rejected")), "gated:");
      const rejected = yield* review("user", "rejected");
      assert.strictEqual(rejected.finding.disposition, "rejected");
      assert.deepStrictEqual(rejected.finding.review, {
        by: "user",
        at: "1970-01-01T00:00:00.000Z",
        reason: "user says so",
      });

      const reopened = yield* review(`thread:${other}`, "open");
      assert.strictEqual(reopened.finding.disposition, "open");
      assert.strictEqual(reopened.finding.review?.by, `thread:${other}`);
      const issue = yield* store.getIssue({ projectId, id: issueId });
      assert.deepStrictEqual(issue.findings, [reopened.finding]);
      assert.deepStrictEqual(
        issue.log.filter((entry) => entry.kind === "finding").map((entry) => entry.text),
        [
          `${finding.id} added: ${finding.title}`,
          `${finding.id} rejected: user says so`,
          `${finding.id} open: thread:${other} says so`,
        ],
      );
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("moves a finding to the right issue, or to a new Triage issue, as it was", () =>
    Effect.gen(function* () {
      const findings = yield* FindingService.FindingService;
      const store = yield* KanbanStore.KanbanStore;
      const { id: wrong } = yield* store.write(projectId, "user", {
        action: "issue.create",
        title: "Wrong ticket",
      });
      const { id: right } = yield* store.write(projectId, "user", {
        action: "issue.create",
        title: "Right ticket",
      });
      const { finding } = yield* capture((yield* search(finder)).searchId, { issueId: wrong });

      const moved = yield* findings.move({ projectId, id: finding.id, issueId: right }, "user");
      assert.deepStrictEqual(moved, { projectId, issueId: right, finding });
      assert.deepStrictEqual((yield* store.getIssue({ projectId, id: wrong })).findings, []);
      assert.deepStrictEqual((yield* store.getIssue({ projectId, id: right })).findings, [finding]);
      assert.strictEqual(
        (yield* store.getIssue({ projectId, id: wrong })).log.at(-1)?.text,
        `${finding.id} moved to ${right}`,
      );
      assert.include(
        yield* failure(findings.move({ projectId, id: finding.id, issueId: right }, "user")),
        "invalid:",
      );
      assert.include(
        yield* failure(findings.move({ projectId, id: finding.id, issueId: "nope" }, "user")),
        "not_found:",
      );

      const detached = yield* findings.move({ projectId, id: finding.id }, `thread:${finder}`);
      const card = yield* store.getIssue({ projectId, id: detached.issueId });
      assert.strictEqual(card.status, "triage");
      assert.deepStrictEqual(card.labels, ["finding"]);
      assert.deepStrictEqual(card.findings, [finding]);
      assert.include(
        yield* failure(
          findings.review({ projectId, id: "nope", disposition: "open", reason: "x" }, "user"),
        ),
        "not_found:",
      );
    }).pipe(Effect.provide(layerTest)),
  );
});
