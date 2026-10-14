import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProjectId,
  Prompt,
  PromptSearchResult,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, McpServer } from "effect/ai";

import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import { liveThreadsLayer } from "../../mcp/McpToolAccess.testkit.ts";
import * as PluginDatabase from "../PluginDatabase.ts";
import { plugin } from "./index.ts";
import { migrations } from "./migrations.ts";
import * as PromptStore from "./prompts/PromptStore.ts";

const environmentId = EnvironmentId.make("env-1");
const agent = ThreadId.make("thread:agent");
/** The project `liveThreadShell` gives every thread. */
const projectId = ProjectId.make("project:mcp-test");

/** A provider session T3 Code launched for the agent's thread. */
const threadScope: McpInvocationContext.McpInvocationScope = {
  environmentId,
  requestNamespace: `provider:${agent}`,
  thread: {
    threadId: agent,
    providerSessionId: `session:${agent}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
};

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "prompts", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "prompts", version: "1" },
  },
  getClient: Effect.die("unused"),
});

/** A failure answers with itself as JSON text. */
const textOf = (result: {
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
}) => result.content[0]?.text ?? "";
const decodeFailure = Schema.decodeUnknownSync(Schema.fromJsonString(OrchestratorMcpFailure));
const decodeSearch = Schema.decodeUnknownSync(PromptSearchResult);
const decodePrompt = Schema.decodeUnknownSync(Prompt);

/** The prompt store over a fresh learning database, where the plugin's MCP layer finds it. */
const layerTest = PromptStore.layer.pipe(
  Layer.provideMerge(
    Layer.effect(
      SqlClient.SqlClient,
      Effect.map(
        PluginDatabase.open({ id: "learning", filename: ":memory:", migrations }),
        (opened) => opened.sql,
      ),
    ),
  ),
  Layer.provideMerge(liveThreadsLayer),
  Layer.provideMerge(NodeServices.layer),
);

/** The plugin's tools registered the way the host registers them, called as the agent's thread. */
const withTools = Effect.gen(function* () {
  const services = yield* Layer.build(
    plugin
      .mcp(McpHttpServer.toolkitRegistration)
      .pipe(Layer.provideMerge(McpServer.McpServer.layer)),
  );
  const server = Context.get(services, McpServer.McpServer);
  const call = (name: string, args: object) =>
    server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, threadScope),
        Effect.provideService(McpSchema.McpServerClient, mcpClient),
      );
  return { server, call };
});

it.effect("lists the prompt tools, with only the save marked as changing things", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { server } = yield* withTools;
      const hints = Object.fromEntries(
        server.tools.map(({ tool }) => [tool.name, tool.annotations?.readOnlyHint]),
      );
      expect(hints).toMatchObject({ prompt_search: true, prompt_save: false, prompt_get: true });
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("an agent's save is refused without a search, and proposed with one", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { call } = yield* withTools;
      const prompt = { kind: "workflow", title: "Ship a fix", body: "1. Test.\n2. Push." };

      const unsearched = yield* call("prompt_save", { searchId: "never-searched", ...prompt });
      expect(unsearched.isError).toBe(true);
      const refused = decodeFailure(textOf(unsearched));
      expect(refused.code).toBe("invalid_request");
      expect(refused.message).toMatch(/^Search the prompt library first/);

      const searched = yield* call("prompt_search", { query: "ship" });
      expect(searched.isError).toBe(false);
      const { searchId, prompts } = decodeSearch(searched.structuredContent);
      expect(prompts).toEqual([]);

      const saved = yield* call("prompt_save", { searchId, ...prompt });
      expect(saved.isError).toBe(false);
      const proposed = decodePrompt(saved.structuredContent);
      expect(proposed).toMatchObject({
        ...prompt,
        projectId,
        state: "proposed",
        origin: "user",
        version: 1,
      });

      const got = yield* call("prompt_get", { id: proposed.id });
      expect(decodePrompt(got.structuredContent)).toEqual(proposed);
      const again = decodeSearch(
        (yield* call("prompt_search", { query: "SHIP fix" })).structuredContent,
      );
      expect(again.prompts).toEqual([proposed]);
      expect(again.searchId).not.toBe(searchId);
    }),
  ).pipe(Effect.provide(layerTest)),
);
