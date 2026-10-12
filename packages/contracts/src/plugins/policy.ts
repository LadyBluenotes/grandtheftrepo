import * as Schema from "effect/Schema";
import { ProjectId, TrimmedNonEmptyString } from "../baseSchemas.ts";
import { definePluginMethods } from "./method.ts";

/** The environment-wide project: its policies reach the agents of every project. */
export const POLICY_ENVIRONMENT_PROJECT_ID = ProjectId.make("*");

/** The agents that read an instruction file from the user's home. */
export const PolicyAgent = Schema.Literals(["claude", "codex", "copilot"]);
export type PolicyAgent = typeof PolicyAgent.Type;
export const POLICY_AGENTS = PolicyAgent.literals;

export const PolicyKey = TrimmedNonEmptyString.check(Schema.isPattern(/^[a-z0-9-]+$/));
export type PolicyKey = typeof PolicyKey.Type;

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

export class PolicyError extends Schema.TaggedError<PolicyError>()("PolicyError", {
  code: Schema.Literals(["inactive", "not_found", "invalid", "io"]),
  message: Schema.String,
}) {}

/** Every method writes the database or a home file, so each answers behind the `operate` gateway. */
export const POLICY_METHODS = definePluginMethods({
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
