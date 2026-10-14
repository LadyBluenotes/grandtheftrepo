import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DETERMINISTIC_METHODS,
  DeterministicProposal,
  type KnowledgeEntry,
  LEARNING_METHODS,
  LearningCorrection,
  LearningError,
  LearningItem,
  LearningItemDetail,
  LearningPromotion,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as KnowledgeStore from "../knowledge/KnowledgeStore.ts";
import * as PluginDatabase from "../PluginDatabase.ts";
import * as PluginRpc from "../PluginRpc.ts";
import * as CorrectionStore from "./CorrectionStore.ts";
import * as ProposalStore from "./deterministic/ProposalStore.ts";
import { table } from "./handlers.ts";
import * as ItemStore from "./items/ItemStore.ts";
import { migrations } from "./migrations.ts";
import * as PromotionStore from "./PromotionStore.ts";
import * as PromptStore from "./prompts/PromptStore.ts";

const projectId = ProjectId.make("project:learning");
const threadId = ThreadId.make("thread:learning");
const range = { projectId, from: "1970-01-01T00:00:00.000Z", to: "2100-01-01T00:00:00.000Z" };

/** A learning read through the read gateway, as a client sends it. */
const read = (method: string, input: unknown) =>
  PluginRpc.dispatch("read", table, { method, input });
const decodeError = Schema.decodeUnknownEffect(LearningError);
const decodeCorrection = Schema.decodeUnknownEffect(LearningCorrection);
const decodeCorrections = Schema.decodeUnknownEffect(Schema.Array(LearningCorrection));
const decodeItem = Schema.decodeUnknownEffect(LearningItem);
const decodeItems = Schema.decodeUnknownEffect(Schema.Array(LearningItem));
const decodeItemDetail = Schema.decodeUnknownEffect(LearningItemDetail);
const decodePromotion = Schema.decodeUnknownEffect(LearningPromotion);

it.effect("answers with the inactive error while the plugin is off", () =>
  Effect.gen(function* () {
    const refused = yield* read(LEARNING_METHODS.corrections.method, range).pipe(
      Effect.andThen(Effect.die("expected a failure")),
      Effect.flip,
    );
    if (refused._tag !== "PluginMethodError") throw new Error(refused.message);
    const error = yield* decodeError(refused.error);
    assert.strictEqual(error.code, "inactive");
    assert.strictEqual(error.message, 'Plugin "learning" is not running.');
  }),
);

it.effect("lists and reads corrections through the store while the plugin runs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { sql } = yield* PluginDatabase.open({
        id: "learning",
        filename: ":memory:",
        migrations,
      });
      const layer = CorrectionStore.layer.pipe(
        Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
      );
      const store = yield* CorrectionStore.CorrectionStore.pipe(Effect.provide(layer));
      // As `thread.created` leaves it: a manual row needs a thread the plugin has seen.
      yield* sql`INSERT INTO threads (thread_id, project_id) VALUES (${threadId}, ${projectId})`;
      const recorded = yield* store.record({
        projectId,
        threadId,
        failureKind: "manual",
        description: "Wrong file.",
        sourceEventIds: [],
        sourceKey: null,
      });
      const listed = yield* read(LEARNING_METHODS.corrections.method, range).pipe(
        Effect.flatMap(decodeCorrections),
        Effect.provide(layer),
      );
      assert.deepEqual(listed, [recorded]);
      const one = yield* read(LEARNING_METHODS.correction.method, { id: recorded.id }).pipe(
        Effect.flatMap(decodeCorrection),
        Effect.provide(layer),
      );
      assert.deepEqual(one, recorded);
    }),
  ),
);

it.effect("lists, reads and disposes items through the gateway, refusing promoted by hand", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { sql } = yield* PluginDatabase.open({
        id: "learning",
        filename: ":memory:",
        migrations,
      });
      const layer = ItemStore.layer.pipe(Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)));
      const items = yield* ItemStore.ItemStore.pipe(Effect.provide(layer));
      const item = yield* items.strengthen(projectId, "convention", "correction:1", "Wrong file.");

      const listed = yield* read(LEARNING_METHODS.items.method, {
        projectId,
        state: "candidate",
      }).pipe(Effect.flatMap(decodeItems), Effect.provide(layer));
      assert.deepEqual(listed, [item]);
      const detail = yield* read(LEARNING_METHODS.item.method, { id: item.id }).pipe(
        Effect.flatMap(decodeItemDetail),
        Effect.provide(layer),
      );
      assert.deepEqual(
        detail.evidence.map((e) => [e.evidenceKey, e.summary]),
        [["correction:1", "Wrong file."]],
      );

      /** A person's disposition through the operate gateway, as a client sends it. */
      const dispose = (input: unknown) =>
        PluginRpc.dispatch("operate", table, {
          method: LEARNING_METHODS.itemsSetDisposition.method,
          input,
        }).pipe(Effect.provide(layer));
      // Neither an owner kind nor a state is refused, and records no person's disposition.
      const empty = yield* dispose({ id: item.id }).pipe(
        Effect.andThen(Effect.die("expected a failure")),
        Effect.flip,
      );
      if (empty._tag !== "PluginHostError") throw new Error("expected the input to be refused");
      assert.include(empty.message, "A disposition needs an owner kind, a state or both.");
      assert.deepInclude(yield* items.get(item.id).pipe(Effect.map((d) => d.item)), {
        dispositionBy: "rule",
        updatedAt: item.updatedAt,
      });
      const closed = yield* dispose({ id: item.id, state: "closed" }).pipe(
        Effect.flatMap(decodeItem),
      );
      assert.deepInclude(closed, { state: "closed", dispositionBy: "person" });
      const refused = yield* dispose({ id: item.id, state: "promoted" }).pipe(
        Effect.andThen(Effect.die("expected a failure")),
        Effect.flip,
      );
      if (refused._tag !== "PluginMethodError") throw new Error(refused.message);
      const error = yield* decodeError(refused.error);
      assert.strictEqual(error.code, "invalid");
      assert.strictEqual(error.message, "State promoted is set by promotion");
    }),
  ),
);

it.effect("a client's verdict and rollback go through the operate gateway as a person's", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { sql } = yield* PluginDatabase.open({
        id: "learning",
        filename: ":memory:",
        migrations,
      });
      const layer = ItemStore.layer.pipe(Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)));
      const items = yield* ItemStore.ItemStore.pipe(Effect.provide(layer));
      /** The item for `mode`, routed to policy by the rules or a person, with its draft in review. */
      const inReview = (mode: string, routedBy: "rule" | "person") =>
        Effect.gen(function* () {
          const item = yield* items.strengthen(projectId, mode, `${mode}:1`, "Wrong file.");
          if (routedBy === "person")
            yield* items.setDisposition({ id: item.id, ownerKind: "policy" });
          const now = yield* DateTime.now;
          yield* PromotionStore.open(
            {
              id: item.id,
              project_id: projectId,
              failure_mode: mode,
              owner_kind: "policy",
              disposition_by: routedBy,
            },
            now,
          );
          const [promotion] = yield* PromotionStore.forItem(item.id);
          yield* PromotionStore.deliver(promotion!, now);
          return { item, promotion: promotion! };
        }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
      const operate = (method: string, input: unknown) =>
        PluginRpc.dispatch("operate", table, { method, input }).pipe(Effect.provide(layer));
      const refusal = (method: string, input: unknown) =>
        operate(method, input).pipe(
          Effect.andThen(Effect.die("expected a failure")),
          Effect.flip,
          Effect.flatMap((refused) =>
            refused._tag === "PluginMethodError"
              ? decodeError(refused.error)
              : Effect.die(refused.message),
          ),
        );

      const ruled = yield* inReview("scope_drift", "rule");
      const adopted = yield* operate(LEARNING_METHODS.promotionReview.method, {
        promotionId: ruled.promotion.id,
        verdict: "adopt",
      }).pipe(Effect.flatMap(decodePromotion));
      assert.strictEqual(adopted.state, "adopted");
      const detail = yield* items.get(ruled.item.id);
      assert.strictEqual(detail.item.state, "promoted");
      assert.deepEqual(
        detail.reviews.map((review) => [review.verdict, review.reviewer]),
        [["adopt", "user"]],
      );

      // A person routed this one, so a person's verdict on it is refused.
      const routed = yield* inReview("convention", "person");
      const refused = yield* refusal(LEARNING_METHODS.promotionReview.method, {
        promotionId: routed.promotion.id,
        verdict: "adopt",
      });
      assert.strictEqual(refused.code, "invalid");
      assert.strictEqual((yield* items.get(routed.item.id)).item.state, "candidate");

      const rolledBack = yield* operate(LEARNING_METHODS.promotionRollBack.method, {
        promotionId: ruled.promotion.id,
      }).pipe(Effect.flatMap(decodePromotion));
      assert.deepInclude(rolledBack, { state: "rolled_back", rolledBackBy: "user" });
      assert.strictEqual((yield* items.get(ruled.item.id)).item.state, "open");
    }),
  ),
);

it.effect(
  "a proposal is decided only through the gateway its draft's target asks for: settings for scripts and pages, operate for the rest",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { sql } = yield* PluginDatabase.open({
          id: "learning",
          filename: ":memory:",
          migrations,
        });
        const project = {
          id: projectId,
          title: "Learning",
          workspaceRoot: "/repos/learning",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        };
        // A knowledge plugin that saves and discards drafts in memory.
        const pages: Array<KnowledgeEntry> = [];
        const knowledge = Layer.mock(KnowledgeStore.KnowledgeStore)({
          list: () => Effect.sync(() => [...pages]),
          propose: (input, source) =>
            Effect.sync(() => {
              const page: KnowledgeEntry = {
                id: pages.length + 1,
                ...input,
                state: "draft",
                source,
                createdAt: "2026-10-12T00:00:00.000Z",
                acceptedAt: null,
                retiredAt: null,
              };
              pages.push(page);
              return page;
            }),
          discard: ({ id }) =>
            Effect.sync(() => {
              const index = pages.findIndex((page) => page.id === id);
              pages[index] = { ...pages[index]!, state: "retired" };
              return pages[index]!;
            }),
        });
        const context = yield* Layer.build(
          Layer.mergeAll(ProposalStore.layer, knowledge, ServerSettings.layerTest()).pipe(
            Layer.provideMerge(PromptStore.layer),
            Layer.provideMerge(
              Layer.mergeAll(
                Layer.succeed(SqlClient.SqlClient, sql),
                NodeServices.layer,
                Layer.mock(ProjectService.ProjectService)({
                  getShell: () => Effect.succeed(Option.some(project)),
                }),
              ),
            ),
          ),
        );
        const store = Context.get(context, ProposalStore.ProposalStore);
        const example = { threadId: "thread:example", runId: null, itemIds: ["item:a"] };
        const candidate = (id: string, form: "script" | "skill" | "context_file") => ({
          id,
          kind: "step" as const,
          steps: [form === "script" ? "command:vp run check" : "Read docs/arch.md"],
          threads: 3,
          occurrences: 3,
          deterministicRatio: 1,
          estimatedTokens: 1000,
          form,
          example,
        });
        yield* store.propose({
          projectId,
          windowFrom: "2026-10-05T00:00:00.000Z",
          candidates: [
            candidate("5c41970000000001", "script"),
            candidate("5c111a0000000001", "skill"),
            candidate("c0de000000000001", "context_file"),
          ],
          dryRun: false,
        });
        // As the sweep does, with the sibling plugins it would see.
        yield* store
          .draftWaiting({ projectIds: new Set([projectId]), dryRun: false })
          .pipe(Effect.provide(context));
        const byForm = new Map((yield* store.list({ projectId })).map((p) => [p.form, p.id]));

        /** A decision through `gateway`, as a client sends it. */
        const decide = (gateway: "operate" | "settingsWrite", method: string, input: unknown) =>
          PluginRpc.dispatch(gateway, table, { method, input }).pipe(Effect.provide(context));
        const refusal = (gateway: "operate" | "settingsWrite", method: string, input: unknown) =>
          decide(gateway, method, input).pipe(
            Effect.andThen(Effect.die("expected a failure")),
            Effect.flip,
            Effect.flatMap((failure) =>
              failure._tag === "PluginMethodError"
                ? Effect.map(decodeError(failure.error), (error) => error.message)
                : Effect.succeed(failure.message),
            ),
          );
        const decided = (gateway: "operate" | "settingsWrite", method: string, input: unknown) =>
          decide(gateway, method, input).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(DeterministicProposal)),
          );
        const { accept, acceptSettings, dismiss, dismissSettings } = DETERMINISTIC_METHODS;
        const script = { id: byForm.get("script")! };
        const prompt = { id: byForm.get("skill")! };
        const page = { id: byForm.get("context_file")!, reason: "Covered already." };

        // Each method answers only through its own gateway.
        assert.strictEqual(
          yield* refusal("operate", acceptSettings.method, script),
          'Method "learning.deterministicAcceptSettings" needs the settingsWrite scope.',
        );
        assert.strictEqual(
          yield* refusal("settingsWrite", accept.method, prompt),
          'Method "learning.deterministicAccept" needs the operate scope.',
        );
        // A grant other than the one the draft's target asks for is refused, naming the method.
        assert.strictEqual(
          yield* refusal("operate", accept.method, script),
          `Proposal ${script.id} is decided with learning.deterministicAcceptSettings, which needs the settingsWrite grant.`,
        );
        assert.strictEqual(
          yield* refusal("settingsWrite", acceptSettings.method, prompt),
          `Proposal ${prompt.id} is decided with learning.deterministicAccept, which needs the operate grant.`,
        );
        assert.strictEqual(
          yield* refusal("operate", dismiss.method, page),
          `Proposal ${page.id} is decided with learning.deterministicDismissSettings, which needs the settingsWrite grant.`,
        );
        assert.strictEqual(
          yield* refusal("settingsWrite", dismissSettings.method, { ...prompt, reason: "No." }),
          `Proposal ${prompt.id} is decided with learning.deterministicDismiss, which needs the operate grant.`,
        );

        // Through the right ones, each is decided.
        assert.strictEqual(
          (yield* decided("settingsWrite", acceptSettings.method, script)).state,
          "accepted",
        );
        assert.strictEqual((yield* decided("operate", accept.method, prompt)).state, "accepted");
        assert.strictEqual(
          (yield* decided("settingsWrite", dismissSettings.method, page)).state,
          "dismissed",
        );
        assert.strictEqual(pages[0]?.state, "retired");
      }),
    ),
);
