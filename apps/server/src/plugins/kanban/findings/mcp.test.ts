import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  KanbanFindingPlacement,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type Project,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../../../config.ts";
import * as McpHttpServer from "../../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import { liveThreadsLayer } from "../../../mcp/McpToolAccess.testkit.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import { plugin } from "../index.ts";
import * as KanbanStore from "../KanbanStore.ts";
import * as FindingService from "./FindingService.ts";

const environmentId = EnvironmentId.make("env-1");
/** The project `liveThreadShell` puts every thread in. */
const projectId = ProjectId.make("project:mcp-test");
const finder = ThreadId.make("thread:finder");
const reviewer = ThreadId.make("thread:reviewer");

/** A provider session T3 Code launched for `threadId`. */
const threadScope = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: `provider:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `session:${threadId}`,
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
const decodePlacement = Schema.decodeUnknownSync(KanbanFindingPlacement);

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "findings", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "findings", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const project: Project = {
  id: projectId,
  title: "Grand Theft Repo",
  workspaceRoot: "/unused",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  deletedAt: null,
};

const layerTest = FindingService.layer.pipe(
  Layer.provideMerge(KanbanStore.layer),
  Layer.provideMerge(
    Layer.mock(ProjectService.ProjectService)({
      getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
    }),
  ),
  Layer.provideMerge(liveThreadsLayer),
  Layer.provideMerge(
    Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-findings-mcp-" })),
  ),
  Layer.provideMerge(NodeServices.layer),
);

/** The tools as the host registers them: `plugin.mcp(toolkitRegistration)`. */
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
  /** The text of a string answer, or of a failure. */
  const text = (scope: McpInvocationContext.McpInvocationScope, name: string, args: object) =>
    Effect.map(call(scope, name, args), (result) =>
      typeof result.structuredContent === "string"
        ? result.structuredContent
        : ((result.content[0] as { readonly text?: string } | undefined)?.text ?? ""),
    );
  const searchId = (threadId: ThreadId, query: string) =>
    Effect.map(text(threadScope(threadId), "finding_search", { query }), (answer) =>
      answer.split("\n")[0]!.replace("searchId: ", ""),
    );
  return { server, call, text, searchId };
});

const finding = {
  title: "Retry loop has no backoff",
  evidence: "apps/server/src/retry.ts:12 retries in a tight loop.",
  truthStatus: "seen",
  scopeRelation: "pre_existing",
};

it.effect("registers the finding tools with the kanban plugin", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { server } = yield* withTools;
      const hints = Object.fromEntries(
        server.tools.map(({ tool }) => [tool.name, tool.annotations?.readOnlyHint]),
      );
      expect(hints).toMatchObject({
        finding_search: true,
        finding_capture: false,
        finding_review: false,
        finding_move: false,
      });
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("captures only after a recent search from the same thread", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { call, text, searchId } = yield* withTools;
      const capture = (scope: McpInvocationContext.McpInvocationScope, id: string) =>
        call(scope, "finding_capture", { ...finding, projectId, searchId: id });
      const refusal = (scope: McpInvocationContext.McpInvocationScope, id: string) =>
        Effect.map(
          text(scope, "finding_capture", { ...finding, projectId, searchId: id }),
          decodeFailure,
        );

      expect((yield* refusal(threadScope(finder), "s404")).message).toContain("Search first");
      const theirs = yield* searchId(reviewer, "retry");
      expect((yield* refusal(threadScope(finder), theirs)).message).toContain("Search first");
      expect((yield* refusal(clientScope, theirs)).code).toBe("thread_credential_required");
      const stale = yield* searchId(finder, "retry");
      yield* TestClock.adjust(`${FindingService.SEARCH_WINDOW_MINUTES + 1} minutes`);
      expect((yield* refusal(threadScope(finder), stale)).message).toContain("Search first");

      const fresh = yield* searchId(finder, "retry");
      const captured = yield* capture(threadScope(finder), fresh);
      expect(captured.isError).toBe(false);
      // The answer carries the finding's id and title and the issue holding it.
      const placement = decodePlacement(captured.structuredContent);
      expect(placement).toMatchObject({
        projectId,
        issueId: "retry-loop-has-no-backoff",
        finding: { id: "retry-loop-has-no-backoff", title: finding.title, disposition: "open" },
      });

      // The next search finds it, so a second agent attaches to it instead of filing it again.
      const found = yield* text(threadScope(reviewer), "finding_search", { query: "backoff" });
      expect(found).toContain(
        "retry-loop-has-no-backoff · open · seen · Retry loop has no backoff · on retry-loop-has-no-backoff (triage)",
      );
      const listed = yield* text(threadScope(reviewer), "kanban_list", {
        kind: "issue",
        id: placement.issueId,
      });
      expect(listed).toContain("Findings:\n- retry-loop-has-no-backoff · open · seen");
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("refuses the proposer's own review and reopens a rejected finding", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { call, text, searchId } = yield* withTools;
      const captured = decodePlacement(
        (yield* call(threadScope(finder), "finding_capture", {
          ...finding,
          searchId: yield* searchId(finder, "retry"),
        })).structuredContent,
      );
      const review = (threadId: ThreadId, disposition: string) =>
        call(threadScope(threadId), "finding_review", {
          id: captured.finding.id,
          disposition,
          reason: "Checked the call sites.",
        });

      const own = yield* text(threadScope(finder), "finding_review", {
        id: captured.finding.id,
        disposition: "rejected",
        reason: "Never mind.",
      });
      expect(decodeFailure(own).message).toContain("someone other than the one who captured it");

      const rejected = decodePlacement((yield* review(reviewer, "rejected")).structuredContent);
      expect(rejected.finding).toMatchObject({
        disposition: "rejected",
        review: { by: `thread:${reviewer}`, reason: "Checked the call sites." },
      });
      const reopened = decodePlacement((yield* review(reviewer, "open")).structuredContent);
      expect(reopened.finding.disposition).toBe("open");

      // A finding on the wrong card moves, by its proposer too.
      const moved = decodePlacement(
        (yield* call(threadScope(finder), "finding_move", {
          id: captured.finding.id,
        })).structuredContent,
      );
      expect(moved.issueId).toBe("retry-loop-has-no-backoff-2");
      expect(moved.finding).toEqual(reopened.finding);
    }),
  ).pipe(Effect.provide(layerTest)),
);
