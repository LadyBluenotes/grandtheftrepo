import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { RequestRow } from "./ReviewRequests.ts";
import { approve, harness, later, ready, reviewed, reviewer, sendBack } from "./testkit.ts";

interface FlagRow {
  readonly plugin_id: string;
  readonly thread_id: string;
  readonly kind: string;
  readonly text: string;
  readonly cleared_at: string | null;
}

/** The harness with readers for the request rows and the host's flags. */
const fixture = Effect.gen(function* () {
  const kit = yield* harness;
  return {
    ...kit,
    rows: kit.review<RequestRow>`SELECT * FROM review_request ORDER BY id`,
    flags: kit.host<FlagRow>`SELECT plugin_id, thread_id, kind, text, cleared_at
      FROM attention ORDER BY id`,
  };
});

it.effect(
  "a later checkpoint makes the request stale, raises one flag and opens one request there",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { requests, sweep, captureLater, rows, flags, changes } = yield* fixture;
        const asked = yield* requests.request({ threadId: reviewed, requestedBy: "user" });
        yield* captureLater;

        // One request went stale and one flag was raised.
        assert.deepEqual(yield* sweep({ dryRun: false }), { examined: 1, acted: 2, flags: 1 });
        const [old, next, ...more] = yield* rows;
        assert.strictEqual(more.length, 0);
        assert.strictEqual(old?.id, asked.id);
        assert.strictEqual(old?.status, "stale");
        assert.isString(old?.stale_at);
        assert.strictEqual(old?.superseded_by, next?.id);
        assert.deepEqual(next, {
          id: next!.id,
          thread_id: reviewed,
          checkpoint_id: later,
          status: "open",
          requested_by: "supervisor",
          requested_at: old!.stale_at!,
          stale_at: null,
          superseded_by: null,
        });
        assert.deepEqual(yield* flags, [
          {
            plugin_id: "review",
            thread_id: reviewed,
            kind: "stale_review",
            text: `Review of checkpoint ${ready} is out of date`,
            cleared_at: null,
          },
        ]);

        // Nothing new: the same counts, and no row in either database touched.
        const before = yield* changes;
        assert.deepEqual(yield* sweep({ dryRun: false }), { examined: 1, acted: 0, flags: 1 });
        assert.strictEqual(yield* changes, before);
      }),
    ),
);

it.effect(
  "a verdict on the later checkpoint leaves the old request open; the new one starts answered",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { requests, record, sweep, captureLater, rows, flags } = yield* fixture;
        yield* requests.request({ threadId: reviewed, requestedBy: "user" });
        yield* captureLater;
        yield* record(reviewer, { ...approve, checkpointId: later });
        assert.deepEqual(
          (yield* rows).map((row) => row.status),
          ["open"],
        );

        // The reviewer already judged `later`, so nothing is left waiting and nothing is flagged.
        assert.deepEqual(yield* sweep({ dryRun: false }), { examined: 1, acted: 1, flags: 0 });
        assert.deepEqual(
          (yield* rows).map((row) => [row.checkpoint_id, row.status]),
          [
            [ready, "stale"],
            [later, "answered"],
          ],
        );
        assert.deepEqual(yield* flags, []);
      }),
    ),
);

it.effect(
  "answering the superseding request clears the flag, and the sweep then changes nothing",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { requests, record, sweep, captureLater, rows, flags, changes } = yield* fixture;
        yield* requests.request({ threadId: reviewed, requestedBy: "user" });
        yield* captureLater;
        yield* sweep({ dryRun: false });

        yield* record(reviewer, { ...sendBack, checkpointId: later });
        assert.deepEqual(
          (yield* rows).map((row) => row.status),
          ["stale", "answered"],
        );
        const [flag, ...others] = yield* flags;
        assert.strictEqual(others.length, 0);
        assert.isString(flag?.cleared_at);

        const before = yield* changes;
        assert.deepEqual(yield* sweep({ dryRun: false }), { examined: 1, acted: 0, flags: 0 });
        assert.strictEqual(yield* changes, before);
      }),
    ),
);

it.effect("an answered request goes stale too, and its verdict is marked invalidated", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { requests, record, list, sweep, captureLater, rows } = yield* fixture;
      yield* requests.request({ threadId: reviewed, requestedBy: "user" });
      yield* record(reviewer, approve);
      yield* captureLater;
      yield* sweep({ dryRun: false });
      assert.deepEqual(
        (yield* rows).map((row) => [row.checkpoint_id, row.status]),
        [
          [ready, "stale"],
          [later, "open"],
        ],
      );
      const [verdict] = yield* list({ threadId: reviewed });
      assert.strictEqual(verdict?.invalidatedAt, (yield* rows)[0]?.stale_at);
    }),
  ),
);

it.effect("stale is permanent: after a rollback the thread gets a new request instead", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { requests, sweep, captureLater, rollBackLater, rows, flags } = yield* fixture;
      const first = yield* requests.request({ threadId: reviewed, requestedBy: "user" });
      yield* captureLater;
      yield* sweep({ dryRun: false });
      yield* rollBackLater;

      // `ready` is the latest again; the request at `later` can no longer be answered.
      assert.deepEqual(yield* sweep({ dryRun: false }), { examined: 1, acted: 2, flags: 1 });
      const all = yield* rows;
      assert.deepEqual(
        all.map((row) => [row.checkpoint_id, row.status]),
        [
          [ready, "stale"],
          [later, "stale"],
          [ready, "open"],
        ],
      );
      assert.strictEqual(all[0]?.id, first.id);
      assert.strictEqual(all[0]?.superseded_by, all[1]?.id);
      assert.strictEqual(all[1]?.superseded_by, all[2]?.id);
      // One flag, rewritten to name the newest stale checkpoint.
      assert.deepEqual(
        (yield* flags).map((flag) => [flag.text, flag.cleared_at]),
        [[`Review of checkpoint ${later} is out of date`, null]],
      );
    }),
  ),
);

it.effect("a dry run counts what it would do and writes nothing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { requests, sweep, captureLater, rows, flags, changes } = yield* fixture;
      yield* requests.request({ threadId: reviewed, requestedBy: "user" });
      yield* captureLater;
      const before = yield* changes;
      assert.deepEqual(yield* sweep({ dryRun: true }), { examined: 1, acted: 2, flags: 1 });
      assert.strictEqual(yield* changes, before);
      assert.deepEqual(
        (yield* rows).map((row) => row.status),
        ["open"],
      );
      assert.deepEqual(yield* flags, []);
    }),
  ),
);

it.effect("examines at most 100 threads a tick and takes the rest on the next", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { review, sweep } = yield* fixture;
      // Threads the read model has no checkpoint for, so the sweep only examines them.
      for (let index = 0; index < 101; index += 1) {
        const threadId = ThreadId.make(`thread:${String(index).padStart(3, "0")}`);
        yield* review`INSERT INTO review_request
          (thread_id, checkpoint_id, status, requested_by, requested_at)
          VALUES (${threadId}, 'checkpoint:x', 'open', 'user', '2026-10-01T00:00:00.000Z')`;
      }
      const examined = [];
      for (let tick = 0; tick < 3; tick += 1) {
        examined.push((yield* sweep({ dryRun: false })).examined);
      }
      assert.deepEqual(examined, [100, 1, 100]);
    }),
  ),
);
