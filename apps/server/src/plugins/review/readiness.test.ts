import { assert, describe, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Attention from "../Attention.ts";
import * as PluginDatabase from "../PluginDatabase.ts";
import { migrations } from "./migrations.ts";
import * as Checks from "./readiness.ts";
import * as SecurityHold from "./security/SecurityHold.ts";

describe("securityCheck", () => {
  it("is ready once a mode is saved", () => {
    assert.strictEqual(Checks.securityCheck("block").status, "ready");
    assert.strictEqual(Checks.securityCheck("off").status, "ready");
  });

  it("flags a project that scans in warn only because nothing was saved", () => {
    assert.strictEqual(Checks.securityCheck(null).status, "attention");
  });
});

it.effect("a project's check turns ready once its mode is saved", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { sql } = yield* PluginDatabase.open({
        id: "review",
        filename: ":memory:",
        migrations,
      });
      const services = yield* Layer.build(
        Layer.merge(Checks.layer, SecurityHold.layer).pipe(
          Layer.provide(Layer.mock(Attention.Attention)({})),
          Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
        ),
      );
      const projectId = ProjectId.make("project-1");
      const readiness = Context.get(services, Checks.ReviewReadiness);

      assert.deepEqual(yield* readiness.checks(null), []);
      assert.deepEqual(
        (yield* readiness.checks(projectId)).map((check) => check.status),
        ["attention"],
      );
      yield* Context.get(services, SecurityHold.SecurityHold).setMode({ projectId, mode: "warn" });
      assert.deepEqual(
        (yield* readiness.checks(projectId)).map((check) => [check.status, check.sentence]),
        [["ready", "Security mode is warn."]],
      );
    }),
  ),
);
