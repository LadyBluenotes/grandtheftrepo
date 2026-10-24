import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ServerPlugin } from "../Plugin.ts";
import * as PluginSupervisor from "../PluginSupervisor.ts";
import { fromService } from "../Readiness.ts";
import * as DeliverySweep from "./DeliverySweep.ts";
import * as KnowledgeStore from "./KnowledgeStore.ts";
import * as Mcp from "./mcp.ts";
import { migrations } from "./migrations.ts";
import * as Checks from "./readiness.ts";

// Registering fails only on a second sweep under this plugin's own name, a defect.
const start = Effect.gen(function* () {
  yield* (yield* PluginSupervisor.PluginSupervisor).register(yield* DeliverySweep.make);
}).pipe(Effect.orDie);

/**
 * Knowledge pages per project: short markdown files a person accepted, written under the
 * project's `.knowledge/` directory, with an index block in each project instruction file an agent
 * in use reads. Agents propose drafts over MCP; people accept and retire them. A supervisor sweep
 * installs what changed, between runs. Turning it off stops installs; written files stay.
 */
export const plugin = {
  id: "knowledge",
  dependsOn: [],
  migrations,
  layer: Layer.merge(Layer.effectDiscard(start), Checks.layer).pipe(
    Layer.provideMerge(KnowledgeStore.layer),
  ),
  mcp: (register) => register(Mcp.KnowledgeToolkit, Mcp.handlers),
  readiness: fromService(Checks.KnowledgeReadiness),
} satisfies ServerPlugin<unknown>;
