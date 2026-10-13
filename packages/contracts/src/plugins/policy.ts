import * as Schema from "effect/Schema";
import { IsoDateTime, ProjectId, TrimmedNonEmptyString } from "../baseSchemas.ts";
import { definePluginMethods } from "./method.ts";

/** The environment-wide project: its policies reach the agents of every project. */
export const POLICY_ENVIRONMENT_PROJECT_ID = ProjectId.make("*");

/** The agents that read an instruction file from the user's home. */
export const PolicyAgent = Schema.Literals(["claude", "codex", "copilot"]);
export type PolicyAgent = typeof PolicyAgent.Type;
export const POLICY_AGENTS = PolicyAgent.literals;

export const PolicyKey = TrimmedNonEmptyString.check(Schema.isPattern(/^[a-z0-9-]+$/));
export type PolicyKey = typeof PolicyKey.Type;

/**
 * The ponytail ladder's rungs, earliest first. The built-in `ponytail` policy states them and the
 * review plugin accepts only these after `rung:` in a `convention` verdict's summary.
 */
export const PonytailRungId = Schema.Literals([
  "needed",
  "existing",
  "platform",
  "dependency",
  "one_line",
  "minimum",
]);
export type PonytailRungId = typeof PonytailRungId.Type;
export const PONYTAIL_RUNG_IDS = PonytailRungId.literals;

export const PolicyState = Schema.Literals(["draft", "accepted", "superseded"]);
export type PolicyState = typeof PolicyState.Type;

export const PolicyVersionRef = Schema.Struct({
  key: PolicyKey,
  version: Schema.Int,
  state: PolicyState,
});
export type PolicyVersionRef = typeof PolicyVersionRef.Type;

export const PolicyCreateInput = Schema.Struct({
  projectId: ProjectId,
  key: PolicyKey,
  title: TrimmedNonEmptyString,
  body: Schema.String,
});
export type PolicyCreateInput = typeof PolicyCreateInput.Type;

export const PolicyAcceptInput = Schema.Struct({
  projectId: ProjectId,
  key: PolicyKey,
  version: Schema.Int,
});
export type PolicyAcceptInput = typeof PolicyAcceptInput.Type;

/** `agents` defaults to every agent. */
export const PolicyAgentsInput = Schema.Struct({
  projectId: ProjectId,
  key: PolicyKey,
  agents: Schema.optional(Schema.Array(PolicyAgent)),
});
export type PolicyAgentsInput = typeof PolicyAgentsInput.Type;

export const PolicyInstallResult = Schema.Struct({
  agent: PolicyAgent,
  /** `skipped` when the agent's directory does not exist; it is never created. */
  status: Schema.Literals(["installed", "skipped"]),
  path: Schema.String,
});
export type PolicyInstallResult = typeof PolicyInstallResult.Type;

export const PolicyVerifyResult = Schema.Struct({
  agent: PolicyAgent,
  /** `drifted` when the block is there but differs; `missing` when the file or the block is gone. */
  status: Schema.Literals(["ok", "drifted", "missing"]),
  path: Schema.String,
  /** The block in the file hashes to what was installed. */
  blockMatches: Schema.Boolean,
  /** The installed block carried the current `RULES.md`. */
  rulesCurrent: Schema.Boolean,
});
export type PolicyVerifyResult = typeof PolicyVerifyResult.Type;

/**
 * What `list` answers for one agent: `verify`'s result, except that an intact block installed from
 * a version other than the accepted one is `outdated`. `verify` says `ok` there, because the block
 * is what was installed; the listing is what shows that a newer acceptance has not been delivered.
 */
export const PolicyDeliveryStatus = Schema.Struct({
  ...PolicyVerifyResult.fields,
  status: Schema.Literals(["ok", "outdated", "drifted", "missing"]),
});
export type PolicyDeliveryStatus = typeof PolicyDeliveryStatus.Type;

/** One version of a policy in its latest state; `at` is when it reached that state. */
export const PolicyVersion = Schema.Struct({
  version: Schema.Int,
  state: PolicyState,
  title: TrimmedNonEmptyString,
  at: IsoDateTime,
});
export type PolicyVersion = typeof PolicyVersion.Type;

/** The last install into one agent's file, as recorded. */
export const PolicyDelivery = Schema.Struct({
  agent: PolicyAgent,
  version: Schema.Int,
  path: Schema.String,
  installedAt: IsoDateTime,
  verifiedAt: Schema.NullOr(IsoDateTime),
});
export type PolicyDelivery = typeof PolicyDelivery.Type;

/**
 * One policy as `list` shows it: the accepted version, else the latest draft, with every version,
 * the last delivery per agent and each agent's file re-read now. `status` is what `verify` would
 * answer, plus `outdated`, read without marking the delivery verified.
 */
export const PolicyListing = Schema.Struct({
  projectId: ProjectId,
  key: PolicyKey,
  title: TrimmedNonEmptyString,
  body: Schema.String,
  version: Schema.Int,
  state: PolicyState,
  updatedAt: IsoDateTime,
  /** Earliest first. */
  versions: Schema.Array(PolicyVersion),
  deliveries: Schema.Array(PolicyDelivery),
  status: Schema.Array(PolicyDeliveryStatus),
});
export type PolicyListing = typeof PolicyListing.Type;

export const PolicyListInput = Schema.Struct({
  /** The project whose policies to list; the environment's (`*`) come with them. */
  projectId: ProjectId,
});
export type PolicyListInput = typeof PolicyListInput.Type;

export class PolicyError extends Schema.TaggedError<PolicyError>()("PolicyError", {
  code: Schema.Literals(["inactive", "not_found", "invalid", "io"]),
  message: Schema.String,
}) {}

/** `list` only reads; every other method writes the database or a home file, so it answers behind `operate`. */
export const POLICY_METHODS = definePluginMethods({
  list: {
    method: "policy.list",
    gateway: "read",
    input: PolicyListInput,
    output: Schema.Array(PolicyListing),
    error: PolicyError,
  },
  create: {
    method: "policy.create",
    gateway: "operate",
    input: PolicyCreateInput,
    output: PolicyVersionRef,
    error: PolicyError,
  },
  accept: {
    method: "policy.accept",
    gateway: "operate",
    input: PolicyAcceptInput,
    output: PolicyVersionRef,
    error: PolicyError,
  },
  install: {
    method: "policy.install",
    gateway: "operate",
    input: PolicyAgentsInput,
    output: Schema.Array(PolicyInstallResult),
    error: PolicyError,
  },
  verify: {
    method: "policy.verify",
    gateway: "operate",
    input: PolicyAgentsInput,
    output: Schema.Array(PolicyVerifyResult),
    error: PolicyError,
  },
});
