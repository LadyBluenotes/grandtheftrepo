import { assert, it } from "@effect/vitest";
import type { ReviewVerdictError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { approve, harness, later, other, ready, reviewed, reviewer, sendBack } from "./testkit.ts";

const refusal = (effect: Effect.Effect<void, ReviewVerdictError>) =>
  effect.pipe(
    Effect.andThen(Effect.die("expected a refusal")),
    Effect.flip,
    Effect.map(({ code, message }) => ({ code, message })),
  );

const outOfDate = (checkpointId: string) => ({
  code: "gated",
  message: `The review is out of date: the thread changed after checkpoint ${checkpointId}.`,
});

it.effect("passes a thread nobody asked to review, and one whose latest review approved", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { gate, requests, record } = yield* harness;
      yield* gate.check(other);
      yield* requests.request({ threadId: reviewed, requestedBy: "user" });
      yield* record(reviewer, approve);
      yield* gate.check(reviewed);
    }),
  ),
);

it.effect("refuses an open request and a review that asked for changes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { gate, requests, record } = yield* harness;
      yield* requests.request({ threadId: reviewed, requestedBy: "user" });
      assert.deepEqual(yield* refusal(gate.check(reviewed)), {
        code: "gated",
        message: "A review was requested and has no verdict yet.",
      });
      yield* record(reviewer, sendBack);
      assert.deepEqual(yield* refusal(gate.check(reviewed)), {
        code: "gated",
        message: "The latest review asked for changes.",
      });
    }),
  ),
);

it.effect("refuses an approval the thread moved past, before and after the sweep marks it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { gate, requests, record, sweep, captureLater } = yield* harness;
      yield* requests.request({ threadId: reviewed, requestedBy: "user" });
      yield* record(reviewer, approve);
      yield* captureLater;
      // The sweep has not run: the thread's own checkpoints say the approval is out of date.
      assert.deepEqual(yield* refusal(gate.check(reviewed)), outOfDate(ready));

      // Now the newest request is the one the sweep opened at `later`.
      yield* sweep({ dryRun: false });
      assert.deepEqual(yield* refusal(gate.check(reviewed)), {
        code: "gated",
        message: "A review was requested and has no verdict yet.",
      });
      yield* record(reviewer, { ...approve, checkpointId: later });
      yield* gate.check(reviewed);
    }),
  ),
);

it.effect("refuses when the newest request is the stale one", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { gate, review } = yield* harness;
      // A superseding request made before the one it replaced, as reusing a standing one leaves.
      const [superseding] = yield* review<{ readonly id: number }>`INSERT INTO review_request
        (thread_id, checkpoint_id, status, requested_by, requested_at)
        VALUES (${reviewed}, ${ready}, 'open', 'user', '2026-10-01T00:00:00.000Z')
        RETURNING id`;
      yield* review`INSERT INTO review_request
        (thread_id, checkpoint_id, status, requested_by, requested_at, stale_at, superseded_by)
        VALUES (${reviewed}, ${later}, 'stale', 'user', '2026-10-02T00:00:00.000Z',
          '2026-10-03T00:00:00.000Z', ${superseding!.id})`;
      assert.deepEqual(yield* refusal(gate.check(reviewed)), outOfDate(later));
    }),
  ),
);
