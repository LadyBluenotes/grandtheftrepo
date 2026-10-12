import {
  CavemanLearnFindings,
  CavemanLearnFindingsInput,
  CavemanStatus,
  OrchestratorMcpFailure,
  type CavemanError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Tool, Toolkit } from "effect/ai";

import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as CavemanService from "./CavemanService.ts";

const CavemanStatusTool = Tool.make("caveman_status", {
  description:
    "Whether caveman's proxy is shrinking what agents on this server read. Reports whether caveman is installed and its version, the proxy origin and whether it is listening (null when the origin is not on this machine), and per provider instance the route: routed (through the proxy), direct, other (a base URL that is neither) or unsupported, with a detail and the config file the answer came from.",
  // No `parameters`: an explicit empty Schema.Struct({}) is not a valid MCP input schema.
  success: CavemanStatus,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const CavemanLearnFindingsTool = Tool.make("caveman_learn_findings", {
  description:
    "Where tokens go on this machine, from the newest `caveman learn` report: the Setup Score (0 to 100), the sessions scanned and the window, and the top sinks by rank (limit, default 10). Each sink has a class (reducible: a mechanical fix exists; recurring_context: re-pasted text; behavioral: a habit, observation only; load_bearing: needed, never changed), a framing (forward_rate: tokensPerTurn and tokensPerDayRate from now on; historical: tokensObserved only) and a suggestion. Every number is an estimate from an offline tokenizer, never verified. Evidence is left out. plan is null until a report has been imported. Nothing here applies a fix: caveman's own caveman-learn skill does that, with a person's consent for each edit.",
  parameters: CavemanLearnFindingsInput,
  success: CavemanLearnFindings,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const CavemanToolkit = Toolkit.make(CavemanStatusTool, CavemanLearnFindingsTool);

const failure = (error: CavemanError) =>
  Effect.fail(new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }));

/**
 * The service is read when the handlers are built, not declared as a tool dependency: plugin
 * services are typed as absent from the server chain, and these tools only register while
 * the plugin is active, which is when the service is there.
 */
export const handlers = McpToolAccess.toLayer(
  CavemanToolkit,
  Effect.map(Effect.serviceOption(CavemanService.CavemanService), (option) => ({
    caveman_status: McpToolAccess.reads(() =>
      Effect.gen(function* () {
        const caveman = yield* CavemanService.fromOption(option);
        return yield* caveman.status;
      }).pipe(Effect.catchTags({ CavemanError: failure })),
    ),
    caveman_learn_findings: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const caveman = yield* CavemanService.fromOption(option);
        return yield* caveman.learnFindings(input);
      }).pipe(Effect.catchTags({ CavemanError: failure })),
    ),
  })),
);
