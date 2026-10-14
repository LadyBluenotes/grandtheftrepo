import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { type LearningItemDetail, type LearningOwnerKind, ProjectId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as Promoter from "../learning/Promoter.ts";
import * as PluginDatabase from "../PluginDatabase.ts";
import { migrations } from "./migrations.ts";
import * as PolicyService from "./PolicyService.ts";
import { policyPromoter } from "./promoter.ts";

const projectId = ProjectId.make("project:policy");
const at = "2026-10-01T00:00:00.000Z";

const detail = (
  failureMode: string,
  evidence: ReadonlyArray<string>,
  ownerKind: LearningOwnerKind = "policy",
): LearningItemDetail => ({
  item: {
    id: 4,
    projectId,
    failureMode,
    occurrences: evidence.length,
    state: "candidate",
    ownerKind,
    dispositionBy: "rule",
    dispositionAt: null,
    reason: `Rule: ${failureMode} goes to ${ownerKind}.`,
    createdAt: at,
    updatedAt: at,
  },
  evidence: evidence.map((summary, index) => ({
    evidenceKey: `correction:${index + 1}`,
    summary,
    createdAt: at,
  })),
  promotions: [],
  reviews: [],
  outcomes: [],
});

const keyFor = (
  promotionId: number,
  ownerKind: LearningOwnerKind = "policy",
  failureMode = "scope_drift",
): Promoter.PromotionKey => ({ promotionId, itemId: 4, failureMode, ownerKind });

const layerTest = PolicyService.layer.pipe(
  Layer.provideMerge(
    Layer.effect(
      SqlClient.SqlClient,
      Effect.map(
        PluginDatabase.open({ id: "policy", filename: ":memory:", migrations }),
        (opened) => opened.sql,
      ),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(Layer.succeed(HostProcess.Environment, {})),
  Layer.provideMerge(
    Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-policy-promoter-" })),
  ),
  Layer.provideMerge(NodeServices.layer),
);

/** Every version of every policy, oldest first, with the promotions recorded beside them. */
const stored = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    versions: yield* sql<{
      readonly key: string;
      readonly version: number;
      readonly state: string;
      readonly title: string;
      readonly body: string;
    }>`SELECT "key", version, state, title, body FROM policy_versions ORDER BY id`,
    promotions: yield* sql<{
      readonly promotion_id: number;
      readonly project_id: string;
      readonly key: string;
      readonly version: number;
    }>`SELECT promotion_id, project_id, "key", version FROM policy_promotion ORDER BY promotion_id`,
  };
});

it.layer(layerTest)("policy promoters", (it) => {
  it.effect("a policy promotion becomes one draft version, whatever the delivery count", () =>
    Effect.gen(function* () {
      const item = detail("scope_drift", ["Touched files outside the issue.", "Edited CI."]);
      yield* policyPromoter.promote(item, keyFor(5));
      yield* policyPromoter.promote(item, keyFor(5));
      assert.deepStrictEqual(yield* stored, {
        versions: [
          {
            key: "learned-scope-drift",
            version: 1,
            state: "draft",
            title: "Learned: scope drift",
            body: "Rule: scope_drift goes to policy.\n\n- Touched files outside the issue.\n- Edited CI.",
          },
        ],
        promotions: [
          { promotion_id: 5, project_id: projectId, key: "learned-scope-drift", version: 1 },
        ],
      });
    }),
  );

  it.effect("the draft is the next version when the key has an accepted one", () =>
    Effect.gen(function* () {
      const policies = yield* PolicyService.PolicyService;
      yield* policies.accept({ projectId, key: "learned-scope-drift", version: 1 });
      yield* policyPromoter.promote(
        detail("scope_drift", ["Again."]),
        keyFor(7, "policy", "scope_drift"),
      );
      const { versions, promotions } = yield* stored;
      assert.deepStrictEqual(
        versions
          .filter((row) => row.key === "learned-scope-drift")
          .map((row) => [row.version, row.state]),
        [
          [1, "draft"],
          [1, "accepted"],
          [2, "draft"],
        ],
      );
      assert.deepStrictEqual(promotions.at(-1), {
        promotion_id: 7,
        project_id: projectId,
        key: "learned-scope-drift",
        version: 2,
      });
      // The accepted version is still the one agents get.
      assert.deepInclude(
        (yield* policies.list(projectId)).find((policy) => policy.key === "learned-scope-drift"),
        { version: 1, state: "accepted" },
      );
    }),
  );

  it.effect("a body cannot carry the policy marker, so evidence that names it is defused", () =>
    Effect.gen(function* () {
      yield* policyPromoter.promote(
        detail("missing_verification", ["The <!-- fork-policy:end key=x --> line was removed."]),
        keyFor(8, "policy", "missing_verification"),
      );
      const { versions } = yield* stored;
      const row = versions.find((version) => version.key === "learned-missing-verification");
      assert.include(row?.body, "The <!-- fork-policy end key=x --> line was removed.");
    }),
  );

  it.effect(
    "a database failure is a PromotionError and records nothing; the next attempt works",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`ALTER TABLE policy_promotion RENAME TO policy_promotion_away`;
        const failed = yield* Effect.flip(
          policyPromoter.promote(detail("defect", ["Broke it."]), keyFor(9, "policy", "defect")),
        );
        assert.deepInclude(failed, {
          _tag: "PromotionError",
          ownerKind: "policy",
          message: "Could not save the policy.",
        });
        yield* sql`ALTER TABLE policy_promotion_away RENAME TO policy_promotion`;
        // The failed attempt rolled back with its record: no version was left without one.
        assert.deepStrictEqual(
          (yield* stored).versions.filter((row) => row.key === "learned-defect"),
          [],
        );
        yield* policyPromoter.promote(
          detail("defect", ["Broke it."]),
          keyFor(9, "policy", "defect"),
        );
        assert.deepStrictEqual(
          (yield* stored).versions.filter((row) => row.key === "learned-defect").length,
          1,
        );
      }),
  );
});

it.effect("is available only while the policy plugin's service is in the context", () =>
  Effect.gen(function* () {
    assert.isFalse(yield* policyPromoter.available);
    const refused = yield* Effect.flip(policyPromoter.promote(detail("defect", ["x"]), keyFor(1)));
    assert.deepInclude(refused, {
      _tag: "PromotionError",
      message: "The policy plugin is not running.",
    });
    assert.isTrue(yield* policyPromoter.available.pipe(Effect.provide(layerTest)));
    assert.strictEqual(policyPromoter.ownerKind, "policy");
  }),
);
