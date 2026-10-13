import { assert, it } from "@effect/vitest";
import { KnowledgeKey, type LearningItemDetail } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Promoter from "../learning/Promoter.ts";
import * as KnowledgeStore from "./KnowledgeStore.ts";
import { promoter } from "./promoter.ts";
import { onHost, projectId, world } from "./testkit.ts";

const at = "2026-10-01T00:00:00.000Z";

/** An item with `evidence` pieces of evidence, numbered from one. */
const detail = (
  evidence: number,
  item: Partial<LearningItemDetail["item"]> = {},
): LearningItemDetail => ({
  item: {
    id: 7,
    projectId,
    failureMode: "convention",
    occurrences: evidence,
    state: "candidate",
    ownerKind: "project_knowledge",
    dispositionBy: "rule",
    dispositionAt: null,
    reason: "Rule: convention goes to project_knowledge.",
    createdAt: at,
    updatedAt: at,
    ...item,
  },
  evidence: Array.from({ length: evidence }, (_, index) => ({
    evidenceKey: `correction:${index + 1}`,
    summary: `Summary ${index + 1}.`,
    createdAt: at,
  })),
  promotions: [],
});

const keyFor = (promotionId: number, itemId = 7): Promoter.PromotionKey => ({
  promotionId,
  itemId,
  failureMode: "convention",
  ownerKind: "project_knowledge",
});

const layerTest = onHost(Layer.empty);

it.effect("a draft page quotes the reason and each piece of evidence as a bullet", () =>
  Effect.gen(function* () {
    const store = yield* KnowledgeStore.KnowledgeStore;
    const w = yield* world;
    const promoted = yield* w.writing(promoter.promote(detail(3), keyFor(3)));
    assert.deepStrictEqual(promoted.writes, []);
    const [page, ...rest] = yield* store.list({ projectId });
    assert.deepStrictEqual(rest, []);
    assert.deepInclude(page, {
      projectId,
      key: "learned-convention-7",
      title: "Learned: convention",
      body: "Rule: convention goes to project_knowledge.\n\n- Summary 1.\n- Summary 2.\n- Summary 3.",
      state: "draft",
      source: { kind: "item", itemId: 7, promotionId: 3 },
    });
    // A draft is a person's to accept; nothing is in the project until then.
    assert.isFalse(yield* w.fs.exists(w.pagesDirectory));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("quotes only the latest five pieces of evidence, with line breaks flattened", () =>
  Effect.gen(function* () {
    const store = yield* KnowledgeStore.KnowledgeStore;
    const many = detail(7);
    yield* promoter.promote(
      {
        ...many,
        evidence: many.evidence.map((entry, index) =>
          index === 6 ? { ...entry, summary: "Seventh\n  and last." } : entry,
        ),
      },
      keyFor(3),
    );
    const [page] = yield* store.list({ projectId });
    assert.strictEqual(
      page?.body,
      [
        "Rule: convention goes to project_knowledge.",
        "",
        "- Summary 3.",
        "- Summary 4.",
        "- Summary 5.",
        "- Summary 6.",
        "- Seventh and last.",
      ].join("\n"),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "a second call for one promotion writes nothing, even after the draft was discarded",
  () =>
    Effect.gen(function* () {
      const store = yield* KnowledgeStore.KnowledgeStore;
      yield* promoter.promote(detail(3), keyFor(3));
      yield* promoter.promote(detail(3), keyFor(3));
      const [draft, ...rest] = yield* store.list({ projectId });
      assert.deepStrictEqual(rest, []);

      yield* store.discard({ id: draft!.id });
      yield* promoter.promote(detail(3), keyFor(3));
      assert.deepStrictEqual(
        (yield* store.list({ projectId })).map((page) => [page.key, page.state]),
        [["learned-convention-7", "retired"]],
      );

      // Another promotion, even of the same item, is its own handover.
      yield* promoter.promote(detail(3), keyFor(4));
      assert.deepStrictEqual(
        (yield* store.list({ projectId })).map((page) => [page.key, page.state, page.source]),
        [
          ["learned-convention-7", "retired", { kind: "item", itemId: 7, promotionId: 3 }],
          ["learned-convention-7", "draft", { kind: "item", itemId: 7, promotionId: 4 }],
        ],
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("a failure mode is cut so the key stays valid, and the item id keeps it unique", () =>
  Effect.gen(function* () {
    const store = yield* KnowledgeStore.KnowledgeStore;
    const failureMode = `efficiency_regression:${Array(4).fill("tool_output_max_per_call").join("_")}`;
    yield* promoter.promote(detail(1, { id: 123456, failureMode }), keyFor(1, 123456));
    const [page] = yield* store.list({ projectId });
    assert.isTrue(Schema.is(KnowledgeKey)(page?.key));
    assert.strictEqual(page?.key.length, 64);
    assert.match(page?.key ?? "", /^learned-efficiency-regression-tool-output-.*-123456$/);
    assert.strictEqual(page?.title, `Learned: ${failureMode.replaceAll("_", " ")}`);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a database failure is a PromotionError, and the next attempt succeeds", () =>
  Effect.gen(function* () {
    const store = yield* KnowledgeStore.KnowledgeStore;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE knowledge_entry RENAME TO knowledge_entry_away`;
    const failed = yield* Effect.flip(promoter.promote(detail(3), keyFor(3)));
    assert.instanceOf(failed, Promoter.PromotionError);
    assert.deepInclude(failed, {
      ownerKind: "project_knowledge",
      message: "Could not read the pages.",
    });

    yield* sql`ALTER TABLE knowledge_entry_away RENAME TO knowledge_entry`;
    yield* promoter.promote(detail(3), keyFor(3));
    assert.deepStrictEqual(
      (yield* store.list({ projectId })).map((page) => page.key),
      ["learned-convention-7"],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses a project the server does not know", () =>
  Effect.gen(function* () {
    const failed = yield* Effect.flip(
      promoter.promote(detail(1, { projectId: "project:gone" as typeof projectId }), keyFor(3)),
    );
    assert.deepInclude(failed, {
      _tag: "PromotionError",
      message: 'Project "project:gone" was not found.',
    });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("is available only while the knowledge plugin's store is in the context", () =>
  Effect.gen(function* () {
    assert.isFalse(yield* promoter.available);
    const refused = yield* Effect.flip(promoter.promote(detail(1), keyFor(3)));
    assert.deepInclude(refused, {
      _tag: "PromotionError",
      message: "The knowledge plugin is not running.",
    });
    assert.isTrue(yield* promoter.available.pipe(Effect.provide(layerTest)));
  }),
);
