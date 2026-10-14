import {
  KanbanError,
  type KanbanAttentionRow,
  type KanbanProjectAttentionRow,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as Attention from "../Attention.ts";
import * as AdherenceService from "../routing/AdherenceService.ts";
import { attentionRows, projectsAttentionRows } from "./attentionRows.ts";

/**
 * What waits on a person in a project, for the strip above the board: live requests from the
 * project's thread shells, open flags from the host's attention table, and, while the routing
 * plugin runs, its mismatches over the past seven days up to now. Nothing here is stored or
 * dismissed; a row leaves when its source stops reporting it.
 */
export class AttentionService extends Context.Service<
  AttentionService,
  {
    readonly list: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<KanbanAttentionRow>, KanbanError>;
    /**
     * `list` for several projects, each once, reading the open flags once; a `policy:*` flag is
     * there once.
     */
    readonly listProjects: (
      projectIds: ReadonlyArray<ProjectId>,
    ) => Effect.Effect<ReadonlyArray<KanbanProjectAttentionRow>, KanbanError>;
  }
>()("t3/plugins/kanban/AttentionService") {}

const io = (message: string) => (cause: unknown) =>
  Effect.logWarning(message, { cause }).pipe(
    Effect.andThen(Effect.fail(new KanbanError({ code: "io", message }))),
  );

/**
 * The routing plugin's mismatches, read where the call runs: the plugin is a sibling, present only
 * while it runs. A routing failure leaves them out rather than failing the strip.
 */
const routingMismatches = (projectId: ProjectId) =>
  Effect.gen(function* () {
    const routing = yield* Effect.serviceOption(AdherenceService.AdherenceService);
    if (Option.isNone(routing)) return [];
    const to = yield* DateTime.now;
    const from = DateTime.subtract(to, { days: 7 });
    const report = yield* routing.value
      .adherence({ projectId, from: DateTime.formatIso(from), to: DateTime.formatIso(to) })
      .pipe(
        Effect.catchTags({
          RoutingError: (cause) =>
            Effect.logWarning("kanban: routing mismatches could not be read", { cause }).pipe(
              Effect.as(null),
            ),
        }),
      );
    return report?.mismatches ?? [];
  });

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const attention = yield* Attention.Attention;

  const openFlags = attention.listAllOpen.pipe(
    Effect.catch(io("Could not read the attention flags.")),
  );
  const projectSources = (projectId: ProjectId) =>
    Effect.all(
      {
        projectId: Effect.succeed(projectId),
        threads: threads
          .listProjectThreads({ projectId, includeSubagents: true })
          .pipe(Effect.catch(io("Could not read the project's threads."))),
        mismatches: routingMismatches(projectId),
      },
      { concurrency: "unbounded" },
    );

  const list = Effect.fn("AttentionService.list")(function* (projectId: ProjectId) {
    const [sources, flags] = yield* Effect.all([projectSources(projectId), openFlags], {
      concurrency: "unbounded",
    });
    return attentionRows({ ...sources, flags });
  });

  const listProjects = Effect.fn("AttentionService.listProjects")(function* (
    projectIds: ReadonlyArray<ProjectId>,
  ) {
    // Each project once, however often it was asked for.
    const ids = [...new Set(projectIds)];
    const [projects, flags] = yield* Effect.all(
      [Effect.forEach(ids, projectSources, { concurrency: 8 }), openFlags],
      { concurrency: "unbounded" },
    );
    return projectsAttentionRows({ projects, flags });
  });

  return AttentionService.of({ list, listProjects });
});

export const layer = Layer.effect(AttentionService, make);
