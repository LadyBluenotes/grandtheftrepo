import { KanbanError, type KanbanAttentionRow, type ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as Attention from "../Attention.ts";
import * as AdherenceService from "../routing/AdherenceService.ts";
import { attentionRows } from "./attentionRows.ts";

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

  const list = Effect.fn("AttentionService.list")(function* (projectId: ProjectId) {
    const [shells, flags, mismatches] = yield* Effect.all(
      [
        threads
          .listProjectThreads({ projectId, includeSubagents: true })
          .pipe(Effect.catch(io("Could not read the project's threads."))),
        attention.listAllOpen.pipe(Effect.catch(io("Could not read the attention flags."))),
        routingMismatches(projectId),
      ],
      { concurrency: "unbounded" },
    );
    return attentionRows({ projectId, threads: shells, flags, mismatches });
  });

  return AttentionService.of({ list });
});

export const layer = Layer.effect(AttentionService, make);
