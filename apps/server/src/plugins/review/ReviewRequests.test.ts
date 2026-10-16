import { assert, it } from "@effect/vitest";
import type { ReviewVerdictError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { approve, harness, later, nobody, ready, reviewed, reviewer } from "./testkit.ts";

const refusal = <A>(effect: Effect.Effect<A, ReviewVerdictError>) =>
  effect.pipe(Effect.andThen(Effect.die("expected a refusal")), Effect.flip);

it.effect(
  "stores the latest ready root checkpoint, and asking again returns the same request",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { requests } = yield* harness;
        // `reviewed` also has a stale checkpoint and a newer ready one outside its root scope.
        const first = yield* requests.request({ threadId: reviewed, requestedBy: "user" });
        assert.deepEqual(first, {
          id: first.id,
          threadId: reviewed,
          checkpointId: ready,
          status: "open",
          requestedBy: "user",
          requestedAt: first.requestedAt,
          staleAt: null,
          supersededBy: null,
        });
        const again = yield* requests.request({ threadId: reviewed, requestedBy: "thread:x" });
        assert.deepEqual(again, first);
        assert.deepEqual(yield* requests.list({ threadId: reviewed }), [first]);
      }),
    ),
);

it.effect("opens a new request once the thread has a later checkpoint, listed newest first", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { requests, captureLater } = yield* harness;
      const first = yield* requests.request({ threadId: reviewed, requestedBy: "user" });
      yield* captureLater;
      const second = yield* requests.request({ threadId: reviewed, requestedBy: "user" });
      assert.strictEqual(second.checkpointId, later);
      assert.notStrictEqual(second.id, first.id);
      assert.deepEqual(
        (yield* requests.list({ threadId: reviewed })).map((request) => request.id),
        [second.id, first.id],
      );
    }),
  ),
);

it.effect("refuses a thread with no checkpoint and one that does not exist", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { requests } = yield* harness;
      const bare = yield* refusal(requests.request({ threadId: reviewer, requestedBy: "user" }));
      assert.strictEqual(bare.code, "invalid");
      assert.strictEqual(bare.message, "This thread has no checkpoint to review yet.");
      const missing = yield* refusal(requests.request({ threadId: nobody, requestedBy: "user" }));
      assert.strictEqual(missing.code, "not_found");
      assert.strictEqual(missing.message, "Thread thread:nobody was not found.");
      assert.deepEqual(yield* requests.list({ threadId: reviewer }), []);
    }),
  ),
);

it.effect(
  "a verdict naming the checkpoint answers the open request; one given first answers it at once",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { requests, record, captureLater } = yield* harness;
        const asked = yield* requests.request({ threadId: reviewed, requestedBy: "user" });
        yield* record(reviewer, approve);
        const [answered] = yield* requests.list({ threadId: reviewed });
        assert.deepEqual(answered, { ...asked, status: "answered" });

        // The reviewer judged `later` before anyone asked, and cannot judge it twice.
        yield* captureLater;
        yield* record(reviewer, { ...approve, checkpointId: later });
        const afterwards = yield* requests.request({ threadId: reviewed, requestedBy: "user" });
        assert.strictEqual(afterwards.checkpointId, later);
        assert.strictEqual(afterwards.status, "answered");
      }),
    ),
);
