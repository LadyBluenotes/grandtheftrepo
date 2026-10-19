import { assert, it } from "@effect/vitest";
import type { ReviewVerdictError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  approve,
  harness,
  later,
  other,
  projectId,
  ready,
  reviewed,
  reviewer,
  sendBack,
} from "./testkit.ts";

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

it.effect("decides by the request still standing after a rollback, not the one made last", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { gate, requests, record, sweep, captureLater, rollBackLater, review } = yield* harness;
      const first = yield* requests.request({ threadId: reviewed, requestedBy: "user" });
      yield* captureLater;
      yield* requests.request({ threadId: reviewed, requestedBy: "user" });
      // Back to `ready` before the sweep ran: the first request still stands there.
      yield* rollBackLater;
      yield* sweep({ dryRun: false });
      assert.deepEqual(
        yield* review<{
          readonly checkpoint_id: string;
          readonly status: string;
          readonly superseded_by: number | null;
        }>`SELECT checkpoint_id, status, superseded_by FROM review_request ORDER BY id`,
        [
          { checkpoint_id: ready, status: "open", superseded_by: null },
          { checkpoint_id: later, status: "stale", superseded_by: first.id },
        ],
      );
      assert.deepEqual(yield* refusal(gate.check(reviewed)), {
        code: "gated",
        message: "A review was requested and has no verdict yet.",
      });
      yield* record(reviewer, approve);
      yield* gate.check(reviewed);
    }),
  ),
);

it.effect(
  "does not pass a thread the security scan holds, nor one whose scan is still to come",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { gate, security, review } = yield* harness;
        // In `block`, with the scan begun before `ready` was captured and no scan of it yet.
        yield* security.setMode({ projectId, mode: "block" });
        yield* review`INSERT INTO security_scan_since (id, since)
        VALUES (1, '2026-09-30T00:00:00.000Z')`;
        assert.deepEqual(yield* refusal(gate.check(reviewed)), {
          code: "scan_pending",
          message:
            "The security scan of this thread's latest checkpoint has not finished. Ask again shortly.",
        });

        // The scan commits with a finding: nobody asked for a review, and the thread still waits.
        yield* review`INSERT INTO security_scan (checkpoint_id, thread_id, scanned_at)
        VALUES (${ready}, ${reviewed}, '2026-10-01T00:00:00.000Z')`;
        yield* review`INSERT INTO security_finding
        (thread_id, checkpoint_id, pattern_id, file, line, blocking, created_at)
        VALUES (${reviewed}, ${ready}, 'secret.token', 'src/config.ts', 2, 1,
          '2026-10-01T00:00:00.000Z')`;
        assert.deepEqual(yield* refusal(gate.check(reviewed)), {
          code: "gated",
          message:
            "Security hold: 1 finding needs acknowledgement. Call review_security_ack with a reason.",
        });

        yield* security.ack({ threadId: reviewed, reason: "A test fixture." });
        yield* gate.check(reviewed);
      }),
    ),
);
