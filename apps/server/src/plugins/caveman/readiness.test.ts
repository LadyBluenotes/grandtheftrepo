import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeNet from "node:net";

import * as Checks from "./readiness.ts";

describe("proxyCheck", () => {
  it("is ready when the proxy answers, or lives on another machine", () => {
    assert.strictEqual(Checks.proxyCheck("http://127.0.0.1:8787", true).status, "ready");
    assert.strictEqual(Checks.proxyCheck("https://gateway.example.com", null).status, "ready");
  });

  it("needs the proxy started when nothing answers on its loopback port", () => {
    const check = Checks.proxyCheck("http://127.0.0.1:8787", false);
    assert.strictEqual(check.status, "attention");
    assert.strictEqual(check.target, "plugins");
  });
});

it.effect("probes the proxy's loopback port once per request", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = NodeNet.createServer();
      yield* Effect.callback<void>((resume) => {
        server.listen(0, "127.0.0.1", () => resume(Effect.void));
      });
      const { port } = server.address() as NodeNet.AddressInfo;
      const readiness = Context.get(yield* Layer.build(Checks.layer), Checks.CavemanReadiness)
        .checks(null)
        .pipe(
          Effect.provideService(HostProcess.Environment, {
            CAVE_GATEWAY_URL: `http://127.0.0.1:${port}`,
          }),
        );

      assert.deepEqual(
        (yield* readiness).map((check) => [check.status, check.sentence]),
        [["ready", `The proxy answers at http://127.0.0.1:${port}.`]],
      );
      yield* Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      });
      assert.deepEqual(
        (yield* readiness).map((check) => check.status),
        ["attention"],
      );
    }),
  ),
);
