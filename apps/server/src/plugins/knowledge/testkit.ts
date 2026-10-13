import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type Project,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as PluginDatabase from "../PluginDatabase.ts";
import * as KnowledgeStore from "./KnowledgeStore.ts";
import { migrations } from "./migrations.ts";

/** The project every thread of `liveThreadShell` belongs to, rooted at `<baseDir>/project`. */
export const projectId = ProjectId.make("project:mcp-test");

type Shells = ReadonlyArray<OrchestrationV2ThreadShell>;

/** The threads the mocked server reports; a test sets them to put a run on the project. */
export class Threads extends Context.Service<Threads, Ref.Ref<Shells>>()(
  "t3/plugins/knowledge/testkit/Threads",
) {}

/** Every call that changes the file system, as `<call> <path>`. */
class FileWrites extends Context.Service<FileWrites, Ref.Ref<ReadonlyArray<string>>>()(
  "t3/plugins/knowledge/testkit/FileWrites",
) {}

/** A thread of the project, with a run, waiting on the user, or idle. */
export const shell = (id: string, run: "none" | "running" | "waiting") => ({
  ...liveThreadShell(ThreadId.make(id), {
    activeRunId: run === "running" ? RunId.make(`run:${id}`) : null,
  }),
  // A run waiting on the user has no `activeRunId`; only its activity status shows it.
  ...(run === "waiting" ? { activityRunStatus: "waiting" as const } : {}),
});

const layerThreads = Layer.unwrap(
  Effect.map(Ref.make<Shells>([]), (threads) =>
    Layer.merge(
      Layer.succeed(Threads, threads),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
        listProjectThreads: ({ projectId: id }) =>
          Effect.map(Ref.get(threads), (all) => all.filter((thread) => thread.projectId === id)),
      }),
    ),
  ),
);

const layerProjects = Layer.unwrap(
  Effect.map(ServerConfig.ServerConfig, ({ baseDir }) => {
    const project: Project = {
      id: projectId,
      title: "Project",
      workspaceRoot: `${baseDir}/project`,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      deletedAt: null,
    };
    return Layer.mock(ProjectService.ProjectService)({
      getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
    });
  }),
);

const layerFileWrites = Layer.unwrap(
  Effect.map(Ref.make<ReadonlyArray<string>>([]), (calls) => {
    const note = (call: string) => Ref.update(calls, (all) => [...all, call]);
    return Layer.merge(
      Layer.succeed(FileWrites, calls),
      Layer.effect(
        FileSystem.FileSystem,
        Effect.map(FileSystem.FileSystem, (fs) => ({
          ...fs,
          writeFileString: (...args: Parameters<typeof fs.writeFileString>) =>
            Effect.andThen(note(`write ${args[0]}`), fs.writeFileString(...args)),
          rename: (...args: Parameters<typeof fs.rename>) =>
            Effect.andThen(note(`rename ${args[1]}`), fs.rename(...args)),
          remove: (...args: Parameters<typeof fs.remove>) =>
            Effect.andThen(note(`remove ${args[0]}`), fs.remove(...args)),
        })),
      ),
    );
  }),
).pipe(Layer.provide(NodeServices.layer));

/** A temp home with Claude's default directory only, so Codex and Copilot are not in use. */
const layerHome = Layer.effect(
  HostProcess.HomeDirectory,
  Effect.gen(function* () {
    const { baseDir } = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = path.join(baseDir, "home");
    yield* fs.makeDirectory(path.join(home, ".claude"), { recursive: true });
    yield* fs.makeDirectory(path.join(baseDir, "project"), { recursive: true });
    return home;
  }),
);

/**
 * `layer` and the store over a temp home and project, an in-memory database, the mocked projects
 * and threads, and the counted file system. The host services stay in the output, so the store
 * finds them with `Effect.serviceOption` where a test calls it.
 */
export const onHost = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
  layer.pipe(
    Layer.provideMerge(KnowledgeStore.layer),
    Layer.provideMerge(
      Layer.effect(
        SqlClient.SqlClient,
        Effect.map(
          PluginDatabase.open({ id: "knowledge", filename: ":memory:", migrations }),
          (opened) => opened.sql,
        ),
      ),
    ),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(layerHome),
    // The runner's own CLAUDE_CONFIG_DIR, CODEX_HOME or COPILOT_HOME must not pick the agents.
    Layer.provideMerge(Layer.succeed(HostProcess.Environment, {})),
    Layer.provideMerge(layerProjects),
    Layer.provideMerge(layerThreads),
    Layer.provideMerge(layerFileWrites),
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-knowledge-test-" })),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

/** The project's files the tests look at, and the file changes made while an effect runs. */
export const world = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { baseDir } = yield* ServerConfig.ServerConfig;
  const home = yield* HostProcess.HomeDirectory;
  const calls = yield* FileWrites;
  const threads = yield* Threads;
  const root = path.join(baseDir, "project");
  return {
    fs,
    root,
    claudeFile: path.join(root, "CLAUDE.md"),
    codexFile: path.join(root, "AGENTS.md"),
    copilotFile: path.join(root, ".github", "copilot-instructions.md"),
    page: (key: string) => path.join(root, ".knowledge", `${key}.md`),
    pagesDirectory: path.join(root, ".knowledge"),
    /** Takes Claude out of use, which leaves no agent in use. */
    dropClaude: fs.remove(path.join(home, ".claude"), { recursive: true }),
    /** Puts Codex in use, as installing it would. */
    useCodex: fs.makeDirectory(path.join(home, ".codex"), { recursive: true }),
    setThreads: (shells: Shells) => Ref.set(threads, shells),
    /** The file changes made while `effect` runs. */
    writing: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        yield* Ref.set(calls, []);
        const value = yield* effect;
        return { value, writes: yield* Ref.get(calls) };
      }),
  };
});
