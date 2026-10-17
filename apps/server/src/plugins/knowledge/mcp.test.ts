import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  KNOWLEDGE_METHODS,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";

import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as PluginRpc from "../PluginRpc.ts";
import { table } from "./handlers.ts";
import { plugin } from "./index.ts";
import * as KnowledgeStore from "./KnowledgeStore.ts";
import { onHost, projectId, world } from "./testkit.ts";

const environmentId = EnvironmentId.make("env-1");
const agent = ThreadId.make("thread:agent");

/** A provider session T3 Code launched for `threadId`. */
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
const clientScope: McpInvocationContext.McpInvocationScope = {
  environmentId,
  requestNamespace: "client:session-1",
  thread: undefined,
  client: { sessionId: "session-1", label: "Claude Code", access: "auto" },
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
};

const decodeFailure = Schema.decodeUnknownSync(Schema.fromJsonString(OrchestratorMcpFailure));
const decodePages = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ key: Schema.String, title: Schema.String })),
);
/**
 * The text an agent reads. A string result is quoted until the protocol unquotes it on the wire,
 * which `callTool` comes before; a failure answers with itself as JSON.
 */
const textOf = (result: {
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  readonly structuredContent?: unknown;
}) =>
  typeof result.structuredContent === "string"
    ? result.structuredContent
    : (result.content[0]?.text ?? "");

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "knowledge", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "knowledge", version: "1" },
  },
  getClient: Effect.die("unused"),
});

/**
 * The plugin registers its tools the way the host does: `plugin.mcp(toolkitRegistration)`, with
 * the store in the surrounding context, never declared as a tool dependency.
 */
const withTools = Effect.gen(function* () {
  const services = yield* Layer.build(
    plugin
      .mcp(McpHttpServer.toolkitRegistration)
      .pipe(Layer.provideMerge(McpServer.McpServer.layer)),
  );
  const server = Context.get(services, McpServer.McpServer);
  const call = (scope: McpInvocationContext.McpInvocationScope, name: string, args: object) =>
    server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, mcpClient),
      );
  return { server, call };
});

const layerTest = onHost(Layer.empty);

it.effect("lists both tools, with the proposal marked as changing things", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { server } = yield* withTools;
      expect(
        Object.fromEntries(
          server.tools.map(({ tool }) => [tool.name, tool.annotations?.readOnlyHint]),
        ),
      ).toEqual({ knowledge_list: true, knowledge_propose: false });
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("an agent's proposal is a draft from its thread, in its thread's project", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { call } = yield* withTools;
      const w = yield* world;
      const page = { key: "tests", title: "Running the tests", body: "Use vp." };
      const result = yield* call(threadScope(agent), "knowledge_propose", page);
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        ...page,
        projectId,
        state: "draft",
        source: { kind: "agent", threadId: agent },
      });
      expect(yield* w.fs.readDirectory(w.root)).toEqual([]);

      const outside = yield* call(clientScope, "knowledge_propose", { ...page, projectId });
      expect(outside.isError).toBe(true);
      expect(decodeFailure(textOf(outside)).code).toBe("thread_credential_required");
      const again = yield* call(threadScope(agent), "knowledge_propose", page);
      expect(decodeFailure(textOf(again)).message).toBe(
        'This project already has a draft page "tests".',
      );
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("knowledge_list names the accepted pages that knowledge.list returns", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { call } = yield* withTools;
      const store = yield* KnowledgeStore.KnowledgeStore;
      expect(textOf(yield* call(threadScope(agent), "knowledge_list", {}))).toBe(
        "No accepted knowledge pages.",
      );
      for (const [key, title] of [
        ["tests", "Running the tests"],
        ["db", "Where the database lives"],
      ] as const) {
        const draft = yield* store.propose(
          { projectId, key, title, body: "Body." },
          { kind: "person" },
        );
        yield* store.accept({ id: draft.id });
      }
      yield* store.propose(
        { projectId, key: "wip", title: "Not yet", body: "Body." },
        { kind: "person" },
      );

      const listed = textOf(yield* call(threadScope(agent), "knowledge_list", {}));
      expect(listed).toBe(
        ".knowledge/db.md: Where the database lives\n.knowledge/tests.md: Running the tests",
      );
      const rpc = yield* decodePages(
        yield* PluginRpc.dispatch("read", table, {
          method: KNOWLEDGE_METHODS.list.method,
          input: { projectId, state: "accepted" },
        }),
      );
      expect(listed).toBe(rpc.map((page) => `.knowledge/${page.key}.md: ${page.title}`).join("\n"));

      expect(textOf(yield* call(clientScope, "knowledge_list", { projectId }))).toBe(listed);
      expect(textOf(yield* call(clientScope, "knowledge_list", {}))).toContain("Pass projectId");
    }),
  ).pipe(Effect.provide(layerTest)),
);
