import * as Schema from "effect/Schema";
import { IsoDateTime } from "../baseSchemas.ts";
import { ProviderInstanceId } from "../providerInstance.ts";
import { definePluginMethods } from "./method.ts";

/**
 * Where a provider sends model requests. `routed`: through caveman's proxy. `direct`: to the
 * vendor. `other`: a base URL that is neither. `unsupported`: this plugin cannot route it.
 */
export const CavemanRoute = Schema.Literals(["routed", "direct", "other", "unsupported"]);
export type CavemanRoute = typeof CavemanRoute.Type;

export const CavemanAgent = Schema.Literals([
  "claude",
  "codex",
  "cursor",
  "grok",
  "opencode",
  "antigravity",
]);
export type CavemanAgent = typeof CavemanAgent.Type;

/** One configured provider instance: its route, and the config file the answer came from. */
export const CavemanAgentRoute = Schema.Struct({
  instanceId: ProviderInstanceId,
  agent: CavemanAgent,
  route: CavemanRoute,
  detail: Schema.NullOr(Schema.String),
  configPath: Schema.NullOr(Schema.String),
});
export type CavemanAgentRoute = typeof CavemanAgentRoute.Type;

export const CavemanStatus = Schema.Struct({
  installed: Schema.Boolean,
  version: Schema.NullOr(Schema.String),
  /** `listening` is null when the origin is not on this machine, so one connect says nothing. */
  proxy: Schema.Struct({ origin: Schema.String, listening: Schema.NullOr(Schema.Boolean) }),
  agents: Schema.Array(CavemanAgentRoute),
});
export type CavemanStatus = typeof CavemanStatus.Type;

export const CavemanSetRouteInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  enabled: Schema.Boolean,
});
export type CavemanSetRouteInput = typeof CavemanSetRouteInput.Type;

/** What the panel shows when caveman is missing; the server's refusal carries the same command. */
export const CAVEMAN_INSTALL_COMMAND = "npm install -g @caveman-ai/cli && caveman setup --install";

/**
 * What a sink is. `reducible`: a mechanical fix exists. `recurring_context`: text re-pasted across
 * sessions. `behavioral`: a habit, observation only. `load_bearing`: needed, never changed.
 */
export const CavemanLearnClass = Schema.Literals([
  "reducible",
  "recurring_context",
  "behavioral",
  "load_bearing",
]);
export type CavemanLearnClass = typeof CavemanLearnClass.Type;

/** `forward_rate`: costs tokens per message from now on. `historical`: only an observed total. */
export const CavemanLearnFraming = Schema.Literals(["forward_rate", "historical"]);
export type CavemanLearnFraming = typeof CavemanLearnFraming.Type;

/**
 * Which report a plan came from. `canonical`: `$CAVEMAN_HOME/reports/caveman-learn.json`, which this
 * server's refresh writes from the home directory. `autopilot`: caveman's own rescan after a session
 * ends, from that session's directory and environment.
 */
export const CavemanLearnSource = Schema.Literals(["canonical", "autopilot"]);
export type CavemanLearnSource = typeof CavemanLearnSource.Type;

/**
 * One place tokens go, ranked from 1, without its evidence. Every count is caveman's estimate from
 * an offline tokenizer, null when caveman did not report it.
 */
export const CavemanLearnFinding = Schema.Struct({
  rank: Schema.Int,
  sinkId: Schema.String,
  title: Schema.String,
  class: CavemanLearnClass,
  framing: CavemanLearnFraming,
  basis: Schema.String,
  tokensPerTurn: Schema.NullOr(Schema.Number),
  tokensObserved: Schema.NullOr(Schema.Number),
  tokensPerDayRate: Schema.NullOr(Schema.Number),
  suggestion: Schema.String,
});
export type CavemanLearnFinding = typeof CavemanLearnFinding.Type;

/** A finding with its evidence, which can hold file paths and line locators: never sent over MCP. */
export const CavemanLearnSink = Schema.Struct({
  ...CavemanLearnFinding.fields,
  evidence: Schema.JsonObject,
});
export type CavemanLearnSink = typeof CavemanLearnSink.Type;

/** One imported `caveman learn` report. `spend` and `wrapMeasured` are caveman's own blocks. */
export const CavemanLearnPlan = Schema.Struct({
  generatedAt: IsoDateTime,
  source: CavemanLearnSource,
  windowFrom: Schema.String,
  windowTo: Schema.String,
  /** The Setup Score, 0 to 100. */
  caveScore: Schema.Number,
  sessionsScanned: Schema.Number,
  caveats: Schema.Array(Schema.String),
  spend: Schema.NullOr(Schema.Json),
  wrapMeasured: Schema.NullOr(Schema.Json),
  importedAt: IsoDateTime,
});
export type CavemanLearnPlan = typeof CavemanLearnPlan.Type;

/** The refresh scan: whether one runs now, and why the last one failed. */
export const CavemanLearnScan = Schema.Struct({
  running: Schema.Boolean,
  lastError: Schema.NullOr(Schema.String),
});
export type CavemanLearnScan = typeof CavemanLearnScan.Type;

/** The newest imported plan with its sinks in rank order, or `none` before the first import. */
export const CavemanLearnPlanResult = Schema.Union([
  Schema.Struct({ state: Schema.Literal("none"), scan: CavemanLearnScan }),
  Schema.Struct({
    state: Schema.Literal("ready"),
    plan: CavemanLearnPlan,
    sinks: Schema.Array(CavemanLearnSink),
    scan: CavemanLearnScan,
  }),
]);
export type CavemanLearnPlanResult = typeof CavemanLearnPlanResult.Type;

export const CavemanLearnFindingsInput = Schema.Struct({
  /** How many findings, from rank 1; 10 when left out. */
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export type CavemanLearnFindingsInput = typeof CavemanLearnFindingsInput.Type;

/** The newest plan, null before the first import, and its top findings without evidence. */
export const CavemanLearnFindings = Schema.Struct({
  plan: Schema.NullOr(CavemanLearnPlan),
  findings: Schema.Array(CavemanLearnFinding),
});
export type CavemanLearnFindings = typeof CavemanLearnFindings.Type;

export class CavemanError extends Schema.TaggedError<CavemanError>()("CavemanError", {
  code: Schema.Literals(["inactive", "not_installed", "not_routed", "busy", "failed"]),
  message: Schema.String,
}) {}

export const CAVEMAN_METHODS = definePluginMethods({
  status: {
    method: "caveman.status",
    gateway: "read",
    input: Schema.Struct({}),
    output: CavemanStatus,
    error: CavemanError,
  },
  setRoute: {
    method: "caveman.setRoute",
    gateway: "settingsWrite",
    input: CavemanSetRouteInput,
    output: CavemanStatus,
    error: CavemanError,
  },
  learnPlan: {
    method: "caveman.learnPlan",
    gateway: "read",
    input: Schema.Struct({}),
    output: CavemanLearnPlanResult,
    error: CavemanError,
  },
  /** Starts `caveman learn scan` in the background; the next sweep imports its report. */
  learnRefresh: {
    method: "caveman.learnRefresh",
    gateway: "settingsWrite",
    input: Schema.Struct({}),
    output: Schema.Struct({ started: Schema.Literal(true) }),
    error: CavemanError,
  },
});
