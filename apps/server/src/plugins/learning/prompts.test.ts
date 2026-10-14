import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  PROMPT_BODY_MAX_LENGTH,
  PROMPT_PREVIEW_LENGTH,
  PROMPT_VERSIONS_LIMIT,
  PROMPTS_LIST_LIMIT,
  ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as PluginDatabase from "../PluginDatabase.ts";
import { migrations } from "./migrations.ts";
import * as PromptStore from "./prompts/PromptStore.ts";

const projectId = ProjectId.make("project:prompts");
const otherProject = ProjectId.make("project:other");

/** The store over a fresh learning database, as the plugin's layer builds it. */
const setup = Effect.gen(function* () {
  const { sql } = yield* PluginDatabase.open({ id: "learning", filename: ":memory:", migrations });
  return yield* PromptStore.PromptStore.pipe(
    Effect.provide(
      PromptStore.layer.pipe(
        Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
});

const text = {
  kind: "prompt",
  title: "Review the diff",
  body: "Read every changed file.",
} as const;

it.effect("a person's save is active; an agent's needs a recent search and is proposed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const prompts = yield* setup;
      const saved = yield* prompts.create({ projectId, ...text });
      assert.deepInclude(saved, { state: "active", origin: "user", version: 1, useCount: 0 });

      const unsearched = yield* Effect.flip(prompts.propose({ searchId: "made-up", ...text }));
      assert.strictEqual(unsearched.code, "invalid");
      assert.match(unsearched.message, /^Search the prompt library first/);

      const { searchId } = yield* prompts.search({ projectId, query: "" });
      const proposed = yield* prompts.propose({
        searchId,
        kind: "workflow",
        title: "Ship a fix",
        body: "1. Test.\n2. Push.",
      });
      assert.deepInclude(proposed, {
        projectId,
        kind: "workflow",
        state: "proposed",
        origin: "user",
        title: "Ship a fix",
      });

      // A search lets a save in for 15 minutes, and no longer.
      yield* TestClock.adjust("15 minutes");
      const stale = yield* Effect.flip(prompts.propose({ searchId, ...text }));
      assert.strictEqual(stale.code, "invalid");
      assert.deepStrictEqual(
        (yield* prompts.list({ projectId })).map((p) => [p.title, p.state]),
        [
          ["Ship a fix", "proposed"],
          ["Review the diff", "active"],
        ],
      );
    }),
  ),
);

it.effect("an agent's save goes to the project its search looked in", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const prompts = yield* setup;
      const { searchId } = yield* prompts.search({ projectId: otherProject, query: "anything" });
      const saved = yield* prompts.propose({ searchId, ...text });
      assert.strictEqual(saved.projectId, otherProject);
      assert.deepStrictEqual(yield* prompts.list({ projectId }), []);
    }),
  ),
);

it.effect("a person accepts a proposed prompt once, and it becomes active", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const prompts = yield* setup;
      const { searchId } = yield* prompts.search({ projectId, query: "" });
      const proposed = yield* prompts.propose({ searchId, ...text });
      yield* TestClock.adjust("1 minute");
      const accepted = yield* prompts.accept(proposed.id);
      assert.deepInclude(accepted, { state: "active", updatedAt: "1970-01-01T00:01:00.000Z" });

      const again = yield* Effect.flip(prompts.accept(proposed.id));
      assert.deepInclude(again, {
        code: "invalid",
        message: `Prompt ${proposed.id} is active; only a proposed prompt is accepted.`,
      });
      const missing = yield* Effect.flip(prompts.accept(99));
      assert.deepInclude(missing, { code: "not_found", message: "No prompt 99." });
    }),
  ),
);

it.effect("editing adds a version, and reverting restores an earlier one as the next", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const prompts = yield* setup;
      const saved = yield* prompts.create({ projectId, ...text });
      const edited = yield* prompts.edit({
        id: saved.id,
        title: text.title,
        body: "Read every changed file, then run the tests.",
      });
      assert.deepInclude(edited, {
        version: 2,
        body: "Read every changed file, then run the tests.",
      });
      // The latest version's text again adds nothing.
      const unchanged = yield* prompts.edit({
        id: saved.id,
        title: edited.title,
        body: edited.body,
      });
      assert.strictEqual(unchanged.version, 2);

      const reverted = yield* prompts.revert({ id: saved.id, version: 1 });
      assert.deepInclude(reverted, { version: 3, title: text.title, body: text.body });
      const { prompt, versions } = yield* prompts.get(saved.id);
      assert.deepStrictEqual(prompt, reverted);
      assert.deepStrictEqual(
        versions.map((v) => [v.version, v.preview]),
        [
          [3, text.body],
          [2, "Read every changed file, then run the tests."],
          [1, text.body],
        ],
      );

      const noVersion = yield* Effect.flip(prompts.revert({ id: saved.id, version: 9 }));
      assert.deepInclude(noVersion, {
        code: "invalid",
        message: `Prompt ${saved.id} has no version 9.`,
      });
      const blank = yield* Effect.flip(prompts.edit({ id: saved.id, title: " ", body: "x" }));
      assert.strictEqual(blank.code, "invalid");
    }),
  ),
);

it.effect("a prompt's detail lists its latest versions as previews, and any one restores", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const prompts = yield* setup;
      const bodyOf = (n: number) => `Version ${n}. ${"x".repeat(PROMPT_BODY_MAX_LENGTH - 12)}`;
      const saved = yield* prompts.create({ projectId, ...text, body: bodyOf(1) });
      for (let n = 2; n <= PROMPT_VERSIONS_LIMIT + 5; n += 1) {
        yield* prompts.edit({ id: saved.id, title: text.title, body: bodyOf(n) });
      }
      const { prompt, versions } = yield* prompts.get(saved.id);
      assert.strictEqual(prompt.version, PROMPT_VERSIONS_LIMIT + 5);
      assert.strictEqual(prompt.body, bodyOf(PROMPT_VERSIONS_LIMIT + 5));
      assert.deepStrictEqual(
        versions.map((v) => v.version),
        Array.from({ length: PROMPT_VERSIONS_LIMIT }, (_, i) => PROMPT_VERSIONS_LIMIT + 5 - i),
      );
      assert.isTrue(versions.every((v) => v.preview.length === PROMPT_PREVIEW_LENGTH));
      // A version past the list still restores by its number.
      const restored = yield* prompts.revert({ id: saved.id, version: 1 });
      assert.deepInclude(restored, { version: PROMPT_VERSIONS_LIMIT + 6, body: bodyOf(1) });
    }),
  ),
);

it.effect("archiving puts a prompt away, and unarchiving returns it to where it was", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const prompts = yield* setup;
      const active = yield* prompts.create({ projectId, ...text });
      const { searchId } = yield* prompts.search({ projectId, query: "" });
      const proposed = yield* prompts.propose({ searchId, ...text, title: "Proposed" });

      assert.strictEqual((yield* prompts.archive(active.id)).state, "archived");
      assert.strictEqual((yield* prompts.archive(proposed.id)).state, "archived");
      const twice = yield* Effect.flip(prompts.archive(active.id));
      assert.strictEqual(twice.code, "invalid");
      assert.deepStrictEqual(
        (yield* prompts.list({ projectId, state: "active" })).map((p) => p.id),
        [],
      );

      // A person saved the first, so it is active again; nobody accepted the second yet.
      assert.strictEqual((yield* prompts.unarchive(active.id)).state, "active");
      assert.strictEqual((yield* prompts.unarchive(proposed.id)).state, "proposed");
      const notArchived = yield* Effect.flip(prompts.unarchive(active.id));
      assert.deepInclude(notArchived, {
        code: "invalid",
        message: `Prompt ${active.id} is active; only an archived prompt is unarchived.`,
      });
    }),
  ),
);

it.effect("a search matches every word in the title or body, active first, most used first", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const prompts = yield* setup;
      const review = yield* prompts.create({ projectId, ...text });
      const tests = yield* prompts.create({
        projectId,
        kind: "prompt",
        title: "Run the tests",
        body: "Run vp test for the changed FILES.",
      });
      const archived = yield* prompts.create({
        projectId,
        kind: "prompt",
        title: "Old review",
        body: "Review changed files by hand.",
      });
      yield* prompts.archive(archived.id);
      yield* prompts.use(tests.id);
      yield* prompts.create({ projectId: otherProject, ...text });

      const found = yield* prompts.search({ projectId, query: "  Changed  FILE " });
      assert.deepStrictEqual(
        found.prompts.map((p) => p.id),
        [tests.id, review.id, archived.id],
      );
      assert.deepStrictEqual(
        (yield* prompts.search({ projectId, query: "review FILE" })).prompts.map((p) => p.id),
        [review.id, archived.id],
      );
      assert.deepStrictEqual((yield* prompts.search({ projectId, query: "deploy" })).prompts, []);

      // A query of thousands of words matches on its first eight distinct ones, so it stays a small
      // condition: here two words nothing holds are among them, and repeats count once.
      const long = ["changed", "file", ...Array.from({ length: 5_000 }, (_, i) => `w${i}`)];
      assert.deepStrictEqual(
        (yield* prompts.search({ projectId, query: long.join(" ") })).prompts,
        [],
      );
      assert.deepStrictEqual(
        (yield* prompts.list({
          projectId,
          query: Array(5_000).fill("FILE changed").join(" "),
        })).map((p) => p.id),
        [tests.id, archived.id, review.id].toSorted((a, b) => b - a),
      );
      // Words that differ only in ASCII case are one word, so they don't use up the eight.
      const cased = ["file", "File", "FILE", "fIle", "FIle", "FILe", "fiLE", "filE", "tests"];
      assert.deepStrictEqual(
        (yield* prompts.search({ projectId, query: cased.join(" ") })).prompts.map((p) => p.id),
        [tests.id],
      );
    }),
  ),
);

it.effect("a sweep's proposal is saved once per source", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const prompts = yield* setup;
      const proposal = {
        projectId,
        ...text,
        origin: "learning",
        sourceKey: "promotion:1",
      } as const;
      const first = yield* prompts.proposeFrom(proposal);
      assert.deepInclude(first, { state: "proposed", origin: "learning" });
      yield* prompts.archive(first.id);
      const repeat = yield* prompts.proposeFrom({ ...proposal, title: "Another title" });
      assert.deepInclude(repeat, { id: first.id, state: "archived", title: text.title });
      assert.strictEqual((yield* prompts.list({ projectId })).length, 1);
    }),
  ),
);

it.effect("the same source in two projects proposes one prompt in each", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const prompts = yield* setup;
      const proposal = { ...text, origin: "repeated_work", sourceKey: "candidate:abc" } as const;
      const here = yield* prompts.proposeFrom({ projectId, ...proposal });
      const there = yield* prompts.proposeFrom({ projectId: otherProject, ...proposal });
      assert.notStrictEqual(here.id, there.id);
      assert.strictEqual(there.projectId, otherProject);
      assert.strictEqual((yield* prompts.proposeFrom({ projectId, ...proposal })).id, here.id);
    }),
  ),
);

it.effect("a list is bounded summaries, narrowed by state and words in the database", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const prompts = yield* setup;
      const long = yield* prompts.create({
        projectId,
        kind: "workflow",
        title: "Release",
        body: `Tag the release. ${"x".repeat(PROMPT_BODY_MAX_LENGTH - 17)}`,
      });
      const [summary] = yield* prompts.list({ projectId });
      assert.strictEqual(summary?.id, long.id);
      assert.strictEqual(summary?.preview, long.body.slice(0, PROMPT_PREVIEW_LENGTH));
      assert.notProperty(summary, "body");

      for (let index = 0; index < PROMPTS_LIST_LIMIT; index += 1) {
        yield* TestClock.adjust("1 second");
        yield* prompts.create({ projectId, ...text, title: `Review ${index}` });
      }
      const listed = yield* prompts.list({ projectId });
      assert.strictEqual(listed.length, PROMPTS_LIST_LIMIT);
      // The newest first, so the oldest, the release, is the one left out.
      assert.strictEqual(listed[0]?.title, `Review ${PROMPTS_LIST_LIMIT - 1}`);
      assert.notInclude(
        listed.map((p) => p.id),
        long.id,
      );
      assert.deepStrictEqual(
        (yield* prompts.list({ projectId, query: "TAG release" })).map((p) => p.id),
        [long.id],
      );
      yield* prompts.archive(long.id);
      assert.deepStrictEqual(
        (yield* prompts.list({ projectId, state: "archived" })).map((p) => p.id),
        [long.id],
      );
      assert.deepStrictEqual(yield* prompts.list({ projectId, state: "proposed" }), []);
      assert.strictEqual(
        (yield* prompts.search({ projectId, query: "review" })).prompts.length,
        10,
      );
    }),
  ),
);

it.effect("a use counts and stamps when, without moving the prompt's update time", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const prompts = yield* setup;
      const saved = yield* prompts.create({ projectId, ...text });
      yield* TestClock.adjust("1 hour");
      yield* prompts.use(saved.id);
      const used = yield* prompts.use(saved.id);
      assert.deepInclude(used, {
        useCount: 2,
        lastUsedAt: "1970-01-01T01:00:00.000Z",
        updatedAt: saved.updatedAt,
      });
      const missing = yield* Effect.flip(prompts.use(99));
      assert.strictEqual(missing.code, "not_found");
    }),
  ),
);
