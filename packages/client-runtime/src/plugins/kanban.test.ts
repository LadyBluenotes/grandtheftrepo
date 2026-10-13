import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  KANBAN_METHODS,
  KanbanAttentionKind,
  PLUGIN_GATEWAY_WS_METHODS,
  ProjectId,
  RuntimeRequestId,
  ThreadId,
  type KanbanAttentionRow,
  type PluginStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";

import { AVAILABLE_CONNECTION_STATE } from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { presentThreadShell, type EnvironmentThreadShell } from "../state/models.ts";
import { v2Now, v2ThreadShell } from "../state/orchestrationV2TestFixtures.ts";
import {
  createKanbanActiveAtomFamily,
  createKanbanAttentionAtomFamily,
  kanbanAttentionStripRows,
} from "./kanban.ts";

const env = EnvironmentId.make("target");

/** What a server that predates the plugin gateway answers to `plugins.read`. */
class UnknownRpcError extends Schema.TaggedError<UnknownRpcError>()("UnknownRpcError", {
  message: Schema.String,
}) {}

const status = (id: string, active: boolean): PluginStatus => ({
  id,
  dependsOn: [],
  enabled: active,
  active,
  missing: [],
  startError: null,
});

/** An atom runtime connected to `env`, whose session answers with `client`. */
const connectedRuntime = (client: Record<string, (call: unknown) => unknown>) =>
  Atom.runtime(
    Layer.effect(
      EnvironmentRegistry,
      Effect.gen(function* () {
        const supervisor = {
          target: { environmentId: env, label: "target" },
          state: yield* SubscriptionRef.make({
            ...AVAILABLE_CONNECTION_STATE,
            desired: true,
            network: "online",
            phase: "connected",
          }),
          session: yield* SubscriptionRef.make(Option.some({ client } as unknown as RpcSession)),
        } as unknown as EnvironmentSupervisor["Service"];
        return {
          run: <A, E>(_id: EnvironmentId, effect: Effect.Effect<A, E, EnvironmentSupervisor>) =>
            Effect.provideService(effect, EnvironmentSupervisor, supervisor),
          followStream: <A, E>(
            _id: EnvironmentId,
            stream: Stream.Stream<A, E, EnvironmentSupervisor>,
          ) => Stream.provideService(stream, EnvironmentSupervisor, supervisor),
        } as unknown as EnvironmentRegistry["Service"];
      }),
    ),
  );

/** The first answer the atom gives once it is no longer unknown. */
const answer = (registry: AtomRegistry.AtomRegistry, atom: Atom.Atom<boolean | null>) =>
  new Promise<boolean>((resolve) => {
    let stop: (() => void) | undefined;
    let settled = false;
    stop = registry.subscribe(
      atom,
      (value) => {
        if (value === null || settled) return;
        settled = true;
        stop?.();
        resolve(value);
      },
      { immediate: true },
    );
    if (settled) stop();
  });

const activeFor = async (read: (call: unknown) => unknown) => {
  const active = createKanbanActiveAtomFamily(
    connectedRuntime({ [PLUGIN_GATEWAY_WS_METHODS.read]: read }),
  );
  const registry = AtomRegistry.make();
  try {
    return await answer(registry, active(env));
  } finally {
    registry.dispose();
  }
};

it("is on only when plugins.list reports kanban active", async () => {
  expect(
    await activeFor(() => Effect.succeed([status("telemetry", true), status("kanban", true)])),
  ).toBe(true);
});

it.each([
  ["is switched off", [status("kanban", false)]],
  ["is not registered", [status("telemetry", true)]],
])("is off when the plugin %s", async (_name, statuses) => {
  expect(await activeFor(() => Effect.succeed(statuses))).toBe(false);
});

it("is off on a server that does not have the plugin RPCs", async () => {
  expect(
    await activeFor(() =>
      Effect.fail(new UnknownRpcError({ message: "Unknown request tag: plugins.read" })),
    ),
  ).toBe(false);
});

const projectId = ProjectId.make("project-1");

const attentionRow = (
  overrides: Pick<KanbanAttentionRow, "id" | "kind" | "since"> & Partial<KanbanAttentionRow>,
): KanbanAttentionRow => ({
  source: "flag",
  threadId: null,
  threadTitle: null,
  text: "Something waits.",
  resumeAction: { label: "Open thread", target: "thread" },
  ...overrides,
});

/** A question, a permission request and a budget flag, as `kanban.attention.list` returns them. */
const waiting: ReadonlyArray<KanbanAttentionRow> = [
  attentionRow({
    id: "request:question",
    source: "request",
    kind: "question",
    threadId: ThreadId.make("thread-1"),
    threadTitle: "Fix login",
    text: "The agent asked you a question.",
    since: "2026-10-13T08:00:00.000Z",
  }),
  attentionRow({
    id: "request:permission",
    source: "request",
    kind: "permission",
    threadId: ThreadId.make("thread-2"),
    threadTitle: "Add tests",
    text: "The agent wants to run a command.",
    since: "2026-10-13T09:00:00.000Z",
  }),
  attentionRow({
    id: "flag:7",
    kind: "budget_breach",
    text: "Budget breached.",
    resumeAction: { label: "Open budgets", target: "settings" },
    since: "2026-10-13T10:00:00.000Z",
  }),
];

describe("kanbanAttentionStripRows", () => {
  it("labels and titles each row and keeps the order the server gave", () => {
    expect(
      kanbanAttentionStripRows(waiting).map((row) => [row.label, row.title, row.threadId]),
    ).toEqual([
      ["Question", "Fix login", "thread-1"],
      ["Permission", "Add tests", "thread-2"],
      ["Budget breach", "This project", null],
    ]);
  });

  it("calls a thread with a blank title Untitled thread", () => {
    const [row] = kanbanAttentionStripRows([
      attentionRow({
        id: "flag:1",
        kind: "two_writers",
        threadId: ThreadId.make("thread-3"),
        threadTitle: "  ",
        since: "2026-10-13T08:00:00.000Z",
      }),
    ]);
    expect(row?.title).toBe("Untitled thread");
  });

  it("has no rows when nothing waits", () => {
    expect(kanbanAttentionStripRows([])).toEqual([]);
  });

  it.each(KanbanAttentionKind.literals)("has a label for the %s kind", (kind) => {
    const [row] = kanbanAttentionStripRows([
      attentionRow({ id: "flag:1", kind, since: "2026-10-13T08:00:00.000Z" }),
    ]);
    expect(row?.label.trim()).not.toBe("");
  });
});

/** The attention atom over a fixture `plugins.read` answer, with the board and threads as inputs. */
const attentionHarness = (answer: ReadonlyArray<KanbanAttentionRow>) => {
  const reads: unknown[] = [];
  const waiters: Array<{ readonly count: number; readonly resolve: () => void }> = [];
  const board = Atom.make(0);
  const shells = Atom.make<ReadonlyArray<EnvironmentThreadShell>>([]);
  const attention = createKanbanAttentionAtomFamily(
    connectedRuntime({
      [PLUGIN_GATEWAY_WS_METHODS.read]: (call) =>
        Effect.sync(() => {
          reads.push(call);
          for (const waiter of waiters) if (reads.length >= waiter.count) waiter.resolve();
          return answer;
        }),
    }),
    { board: () => board, threadShells: () => shells },
  );
  const registry = AtomRegistry.make();
  const atom = attention({ environmentId: env, input: { projectId } });
  // A mounted view: a query is re-read on a signal only while something reads it.
  const unmount = registry.subscribe(atom, () => undefined, { immediate: true });
  return {
    registry,
    board,
    shells,
    reads,
    /** Resolves once the server has been asked `count` times in all. */
    asked: (count: number) =>
      new Promise<void>((resolve) => {
        if (reads.length >= count) return resolve();
        waiters.push({ count, resolve });
      }),
    rows: () =>
      new Promise<ReadonlyArray<KanbanAttentionRow>>((resolve) => {
        const stop = registry.subscribe(
          atom,
          (result) => {
            if (result._tag !== "Success") return;
            queueMicrotask(stop);
            resolve(result.value);
          },
          { immediate: true },
        );
      }),
    dispose: () => {
      unmount();
      registry.dispose();
    },
  };
};

describe("createKanbanAttentionAtomFamily", () => {
  it("answers with the rows kanban.attention.list returns for the project", async () => {
    const harness = attentionHarness(waiting);
    try {
      const rows = await harness.rows();
      expect(harness.reads).toEqual([
        { method: KANBAN_METHODS.attentionList.method, input: { projectId } },
      ]);
      expect(kanbanAttentionStripRows(rows).map((row) => row.label)).toEqual([
        "Question",
        "Permission",
        "Budget breach",
      ]);
    } finally {
      harness.dispose();
    }
  });

  it("reads again on a board snapshot and when a thread gains a pending request", async () => {
    const harness = attentionHarness(waiting);
    try {
      await harness.asked(1);
      harness.registry.set(harness.board, 1);
      await harness.asked(2);
      harness.registry.set(harness.shells, [
        presentThreadShell(env, {
          ...v2ThreadShell,
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("request-1"),
            kind: "user_input",
            createdAt: v2Now,
          },
        }),
      ]);
      await harness.asked(3);
      expect(harness.reads).toHaveLength(3);
    } finally {
      harness.dispose();
    }
  });

  it.each([
    ["archived", { archivedAt: v2Now }],
    ["deleted", { deletedAt: v2Now }],
  ])("reads again when a thread with a pending request is %s", async (_name, lifecycle) => {
    const waitingThread = {
      ...v2ThreadShell,
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("request-1"),
        kind: "user_input" as const,
        createdAt: v2Now,
      },
    };
    const harness = attentionHarness(waiting);
    try {
      await harness.asked(1);
      harness.registry.set(harness.shells, [presentThreadShell(env, waitingThread)]);
      await harness.asked(2);
      // The request stays pending; only the thread's lifecycle changes, as it does when another
      // client archives or deletes it.
      harness.registry.set(harness.shells, [
        presentThreadShell(env, { ...waitingThread, ...lifecycle }),
      ]);
      await harness.asked(3);
      expect(harness.reads).toHaveLength(3);
    } finally {
      harness.dispose();
    }
  });
});
