import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  type ThreadId,
  type AuthMcpClientAccess,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, McpServer } from "effect/ai";

import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as CorrectionStore from "../learning/CorrectionStore.ts";
import { plugin } from "./index.ts";
import * as VerdictStore from "./VerdictStore.ts";
import {
  approve,
  foreign,
  harness,
  layerThreads,
  reviewed,
  reviewer,
  sendBack,
  withoutMode,
} from "./testkit.ts";

const environmentId = EnvironmentId.make("env-1");

/** A provider session T3 Code launched for `threadId`, the only kind that may give a verdict. */
const threadScope = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: `provider:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `session:${threadId}`,
    // The instance `liveThreadShell` gives every thread.
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
});

/** An agent T3 Code did not launch, signed in through MCP OAuth. */
const clientScope = (access: AuthMcpClientAccess): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: "client:session-1",
  thread: undefined,
  client: { sessionId: "session-1", label: "Claude Code", access },
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
});

const decodeFailure = Schema.decodeUnknownSync(Schema.fromJsonString(OrchestratorMcpFailure));
/** A tool that failed answers with the failure as JSON text. */
const failureOf = (result: {
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
}) => decodeFailure(result.content[0]?.text ?? "");

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "review", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "review", version: "1" },
  },
  getClient: Effect.die("unused"),
});

/**
 * The plugin registers its tools the way the host does: `plugin.mcp(toolkitRegistration)`, with
 * both stores in the surrounding context, never declared as tool dependencies.
 */
const withTools = Effect.gen(function* () {
  const kit = yield* harness;
  const services = yield* Layer.build(
    plugin
      .mcp(McpHttpServer.toolkitRegistration)
      .pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(Layer.succeed(SqlClient.SqlClient, kit.review)),
        Layer.provide(Layer.succeed(VerdictStore.VerdictStore, kit.store)),
        Layer.provide(Layer.succeed(CorrectionStore.CorrectionStore, kit.corrections)),
        Layer.provide(layerThreads),
      ),
  );
  const server = Context.get(services, McpServer.McpServer);
  const call = (scope: McpInvocationContext.McpInvocationScope, name: string, args: object) =>
    server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, mcpClient),
      );
  return { ...kit, server, call };
});

it.effect("lists the review tools with the write tool marked as changing things", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { server } = yield* withTools;
      expect(server.tools.map(({ tool }) => tool.name).toSorted()).toEqual([
        "review_verdict",
        "review_verdicts",
      ]);
      const annotations = Object.fromEntries(
        server.tools.map(({ tool }) => [tool.name, tool.annotations?.readOnlyHint]),
      );
      expect(annotations).toEqual({ review_verdict: false, review_verdicts: true });
    }),
  ),
);

it.effect("tells the reviewer the six rungs in order and how a failed one is reported", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { server } = yield* withTools;
      const description = server.tools.find(({ tool }) => tool.name === "review_verdict")?.tool
        .description;
      expect(description).toContain("needed, existing, platform, dependency, one_line, minimum");
      expect(description).toContain("convention verdict whose summary starts with rung:<id>");
    }),
  ),
);

it.effect(
  "records one verdict and one correction for a thread caller, and again adds nothing",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { call, corrections, verdictCount, correctionCount } = yield* withTools;
        const first = yield* call(threadScope(reviewer), "review_verdict", sendBack);
        expect(first.isError).toBe(false);
        expect(first.structuredContent).toEqual({
          verdictId: expect.any(String),
          correctionId: expect.any(Number),
        });
        const again = yield* call(threadScope(reviewer), "review_verdict", sendBack);
        expect(again.structuredContent).toEqual(first.structuredContent);
        expect(yield* verdictCount).toBe(1);
        expect(yield* correctionCount).toBe(1);
        const { correctionId } = first.structuredContent as { correctionId: number };
        expect(yield* corrections.get(correctionId)).toMatchObject({
          failureKind: "review_verdict",
          declaredMode: "missing_verification",
          threadId: reviewed,
        });
      }),
    ),
);

it.effect("records an approval without a correction", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { call, verdictCount, correctionCount } = yield* withTools;
      const result = yield* call(threadScope(reviewer), "review_verdict", approve);
      expect(result.structuredContent).toEqual({
        verdictId: expect.any(String),
        correctionId: null,
      });
      expect(yield* verdictCount).toBe(1);
      expect(yield* correctionCount).toBe(0);
    }),
  ),
);

it.effect("refuses a bad or missing mode, the reviewer's own thread and a foreign checkpoint", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { call, verdictCount, correctionCount } = yield* withTools;
      const caller = threadScope(reviewer);

      // A mode outside the six never reaches the service: the tool's schema refuses it.
      const badMode = yield* call(caller, "review_verdict", {
        ...sendBack,
        failureMode: "sloppy",
      }).pipe(Effect.flip);
      expect(badMode.message).toContain("failureMode");

      const refusals = [
        [withoutMode, "changes_requested needs a failureMode"],
        [{ ...approve, failureMode: "defect" }, "approve cannot carry a failureMode"],
        [{ ...sendBack, threadId: reviewer }, "A thread cannot review its own work"],
        [
          { ...sendBack, checkpointId: foreign },
          `Checkpoint ${foreign} is not a ready checkpoint of thread ${reviewed}`,
        ],
        [
          { ...sendBack, failureMode: "convention", summary: "rung:bogus" },
          'Unknown rung "bogus". Rungs: needed, existing, platform, dependency, one_line, minimum.',
        ],
      ] as const;
      for (const [input, message] of refusals) {
        const result = yield* call(caller, "review_verdict", input);
        expect(result.isError).toBe(true);
        expect(failureOf(result)).toMatchObject({ code: "invalid_request", message });
      }
      expect(yield* verdictCount).toBe(0);
      expect(yield* correctionCount).toBe(0);
    }),
  ),
);

it.effect("refuses a different payload for a checkpoint the thread already reviewed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { call, verdictCount, correctionCount } = yield* withTools;
      yield* call(threadScope(reviewer), "review_verdict", sendBack);
      const result = yield* call(threadScope(reviewer), "review_verdict", {
        ...sendBack,
        failureMode: "defect",
      });
      expect(result.isError).toBe(true);
      expect(failureOf(result)).toMatchObject({
        code: "invalid_request",
        message: "This thread already reviewed this checkpoint",
      });
      expect(yield* verdictCount).toBe(1);
      expect(yield* correctionCount).toBe(1);
    }),
  ),
);

it.effect("refuses a client that is not a T3 thread, read-only or not, and writes nothing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { call, verdictCount, correctionCount } = yield* withTools;
      for (const access of ["read-only", "auto"] as const) {
        const result = yield* call(clientScope(access), "review_verdict", sendBack);
        expect(result.isError).toBe(true);
      }
      expect(yield* verdictCount).toBe(0);
      expect(yield* correctionCount).toBe(0);
    }),
  ),
);

it.effect("lets any caller read a thread's verdicts", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { call } = yield* withTools;
      yield* call(threadScope(reviewer), "review_verdict", sendBack);
      const result = yield* call(clientScope("read-only"), "review_verdicts", {
        threadId: reviewed,
      });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual([
        expect.objectContaining({
          reviewedThreadId: reviewed,
          reviewerThreadId: reviewer,
          outcome: "changes_requested",
          failureMode: "missing_verification",
          invalidatedAt: null,
        }),
      ]);
    }),
  ),
);
