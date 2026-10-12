import {
  POLICY_AGENTS,
  POLICY_ENVIRONMENT_PROJECT_ID,
  PolicyError,
  PolicyKey,
  type PolicyAcceptInput,
  type PolicyAgent,
  type PolicyAgentsInput,
  type PolicyCreateInput,
  type PolicyInstallResult,
  type PolicyState,
  type PolicyVerifyResult,
  type PolicyVersionRef,
  type ProjectId,
  type ServerSettingsError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import * as ServerSettings from "../../serverSettings.ts";
import * as Files from "./InstructionFiles.ts";
import { blockId, findBlock, placeBlock, renderBlock, sha256 } from "./Render.ts";

interface VersionRow {
  readonly version: number;
  readonly state: PolicyState;
  readonly title: string;
  readonly body: string;
}

interface PolicyRow extends VersionRow {
  readonly project_id: ProjectId;
  readonly key: string;
  readonly updated_at: string;
}

interface DeliveryRow {
  readonly project_id: ProjectId;
  readonly key: string;
  readonly version: number;
  readonly agent: PolicyAgent;
  readonly target_path: string;
  readonly rendered_hash: string;
  readonly rules_hash: string;
  readonly installed_at: string;
  readonly verified_at: string | null;
}

/** One policy as `policies` shows it, with the last delivery per agent. */
export interface PolicyListing {
  readonly projectId: ProjectId;
  readonly key: string;
  readonly title: string;
  readonly version: number;
  readonly state: PolicyState;
  readonly updatedAt: string;
  readonly deliveries: ReadonlyArray<{
    readonly agent: PolicyAgent;
    readonly version: number;
    readonly path: string;
    readonly installedAt: string;
    readonly verifiedAt: string | null;
  }>;
}

export class PolicyService extends Context.Service<
  PolicyService,
  {
    /** Appends the next version as a draft. */
    readonly create: (input: PolicyCreateInput) => Effect.Effect<PolicyVersionRef, PolicyError>;
    /** Accepts one version and supersedes every other accepted one, so accepting an older version restores it. */
    readonly accept: (input: PolicyAcceptInput) => Effect.Effect<PolicyVersionRef, PolicyError>;
    /**
     * Writes the accepted version's block into each agent's instruction file. `beforeWrite` runs
     * under the install lock right before the first file is written, and failing it cancels the
     * install with nothing written. The sweep uses it to look for a run again after the lock wait.
     */
    readonly install: (
      input: PolicyAgentsInput,
      beforeWrite?: Effect.Effect<void, PolicyError>,
    ) => Effect.Effect<ReadonlyArray<PolicyInstallResult>, PolicyError>;
    /** Re-reads each delivered file and compares its block with what was installed. */
    readonly verify: (
      input: PolicyAgentsInput,
    ) => Effect.Effect<ReadonlyArray<PolicyVerifyResult>, PolicyError>;
    /** The project's policies and the environment-wide ones. */
    readonly list: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<PolicyListing>, PolicyError>;
  }
>()("t3/plugins/policy/PolicyService") {}

const invalid = (message: string) => new PolicyError({ code: "invalid", message });
const isKey = Schema.is(PolicyKey);
/** The project id sits inside the markers, so whitespace, angle brackets and the marker word would break parsing. */
const isMarkerSafe = (projectId: string) =>
  !/[\s<>]/.test(projectId) && !projectId.includes("fork-policy:");

/** Database, file and settings failures are logged in full; the caller hears which step failed. */
const io =
  (message: string) =>
  (cause: SqlError.SqlError | PlatformError.PlatformError | ServerSettingsError) =>
    Effect.logWarning(message, { cause }).pipe(
      Effect.andThen(Effect.fail(new PolicyError({ code: "io", message }))),
    );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const services = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | ServerSettings.ServerSettingsService
  >();
  const provided = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideContext(effect, services);
  const rulesPath = yield* Files.rulesPath();
  /** Installs read the files they rewrite, so two at once would drop one's block; verify shares it. */
  const installLock = yield* Semaphore.make(1);
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  /** A missing `RULES.md` is empty. */
  const readRules = Effect.map(Files.read(rulesPath), (text) => text ?? "");

  const versionsOf = (projectId: ProjectId, key: string) =>
    Effect.map(
      sql<VersionRow>`
        SELECT version, state, title, body FROM policy_versions
        WHERE project_id = ${projectId} AND "key" = ${key} ORDER BY id
      `,
      // Ordered by id, so the last row for a version is its state.
      (rows) => new Map(rows.map((row) => [row.version, row])),
    );

  const appendVersion = (projectId: ProjectId, key: string, row: VersionRow, at: string) =>
    sql`INSERT INTO policy_versions ${sql.insert({
      project_id: projectId,
      key,
      version: row.version,
      state: row.state,
      title: row.title,
      body: row.body,
      at,
    })}`;

  /** `policies` shows the accepted version, else the latest draft. */
  const refreshPolicy = (projectId: ProjectId, key: string, at: string) =>
    Effect.gen(function* () {
      const versions = [...(yield* versionsOf(projectId, key)).values()];
      const shown = versions.find((row) => row.state === "accepted") ?? versions.at(-1);
      if (shown === undefined) return;
      yield* sql`INSERT OR REPLACE INTO policies ${sql.insert({
        project_id: projectId,
        key,
        title: shown.title,
        body: shown.body,
        version: shown.version,
        state: shown.state,
        updated_at: at,
      })}`;
    });

  const policyOf = (projectId: ProjectId, key: string) =>
    Effect.flatMap(
      sql<PolicyRow>`SELECT * FROM policies WHERE project_id = ${projectId} AND "key" = ${key}`,
      (rows) =>
        rows[0] === undefined
          ? new PolicyError({ code: "not_found", message: `Policy "${key}" was not found.` })
          : Effect.succeed(rows[0]),
    );

  const create = Effect.fn("PolicyService.create")(
    function* ({ projectId, key, title, body }: PolicyCreateInput) {
      if (!isKey(key)) return yield* invalid(`Policy key "${key}" must match [a-z0-9-]+.`);
      if (!isMarkerSafe(projectId)) {
        return yield* invalid(`Project id "${projectId}" cannot be placed in a policy marker.`);
      }
      if (body.includes("fork-policy:")) {
        return yield* invalid('A policy body cannot contain "fork-policy:".');
      }
      const at = yield* nowIso;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const version = Math.max(0, ...(yield* versionsOf(projectId, key)).keys()) + 1;
          yield* appendVersion(projectId, key, { version, state: "draft", title, body }, at);
          yield* refreshPolicy(projectId, key, at);
          return { key, version, state: "draft" } satisfies PolicyVersionRef;
        }),
      );
    },
    Effect.catchTags({ SqlError: io("Could not save the policy.") }),
  );

  const accept = Effect.fn("PolicyService.accept")(
    function* ({ projectId, key, version }: PolicyAcceptInput) {
      const at = yield* nowIso;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const versions = yield* versionsOf(projectId, key);
          const target = versions.get(version);
          if (target === undefined) {
            return yield* new PolicyError({
              code: "not_found",
              message: `Policy "${key}" version ${version} was not found.`,
            });
          }
          if (target.state !== "accepted") {
            for (const row of versions.values()) {
              if (row.state === "accepted") {
                yield* appendVersion(projectId, key, { ...row, state: "superseded" }, at);
              }
            }
            yield* appendVersion(projectId, key, { ...target, state: "accepted" }, at);
            yield* refreshPolicy(projectId, key, at);
          }
          return { key, version, state: "accepted" } satisfies PolicyVersionRef;
        }),
      );
    },
    Effect.catchTags({ SqlError: io("Could not accept the policy.") }),
  );

  const install = Effect.fn("PolicyService.install")(
    function* (
      { projectId, key, agents = POLICY_AGENTS }: PolicyAgentsInput,
      beforeWrite?: Effect.Effect<void, PolicyError>,
    ) {
      const policy = yield* policyOf(projectId, key);
      if (policy.state !== "accepted") {
        return yield* invalid(`Policy "${key}" version ${policy.version} is not accepted.`);
      }
      // The rules sit inside the block, so a marker there would break it like one in the body.
      const rules = yield* readRules;
      if (rules.includes("fork-policy:")) {
        return yield* invalid(
          `${rulesPath} cannot contain "fork-policy:". Remove that marker and install again.`,
        );
      }
      const id = blockId(projectId, key);
      const block = renderBlock({ id, rules, body: policy.body, version: policy.version });
      const targets = yield* Files.targets();
      // Every file is read before any is written, so a damaged block refuses the whole install.
      const plans: Array<{ agent: PolicyAgent; path: string; next: string | undefined }> = [];
      for (const agent of agents) {
        const filePath = targets[agent];
        if (!(yield* fs.exists(path.dirname(filePath)))) {
          plans.push({ agent, path: filePath, next: undefined });
          continue;
        }
        const text = (yield* Files.read(filePath)) ?? "";
        const found = findBlock(text, id);
        if (found.kind === "damaged") {
          return yield* invalid(
            `${filePath} has a damaged fork-policy block for "${key}". Fix or remove it by hand.`,
          );
        }
        plans.push({ agent, path: filePath, next: placeBlock(text, found, block.text) });
      }
      const at = yield* nowIso;
      if (beforeWrite !== undefined) yield* beforeWrite;
      const results: Array<PolicyInstallResult> = [];
      for (const plan of plans) {
        if (plan.next !== undefined) {
          yield* Files.write(plan.path, plan.next);
          yield* sql`INSERT OR REPLACE INTO deliveries ${sql.insert({
            project_id: projectId,
            key,
            version: policy.version,
            agent: plan.agent,
            target_path: plan.path,
            rendered_hash: block.hash,
            rules_hash: block.rulesHash,
            installed_at: at,
            verified_at: null,
            verification_method: null,
          })}`;
        }
        results.push({
          agent: plan.agent,
          status: plan.next === undefined ? "skipped" : "installed",
          path: plan.path,
        });
      }
      return results;
    },
    installLock.withPermits(1),
    provided,
    Effect.catchTags({
      SqlError: io("Could not record the install."),
      PlatformError: io("Could not write an instruction file."),
      ServerSettingsError: io("Could not read the server settings."),
    }),
  );

  const verify = Effect.fn("PolicyService.verify")(
    function* ({ projectId, key, agents = POLICY_AGENTS }: PolicyAgentsInput) {
      const id = blockId(projectId, key);
      const rulesHash = sha256(yield* readRules);
      const deliveries = new Map(
        (yield* sql<DeliveryRow>`
          SELECT * FROM deliveries WHERE project_id = ${projectId} AND "key" = ${key}
        `).map((row) => [row.agent, row]),
      );
      const targets = yield* Files.targets();
      const at = yield* nowIso;
      const results: Array<PolicyVerifyResult> = [];
      for (const agent of agents) {
        const delivery = deliveries.get(agent);
        if (delivery === undefined) {
          results.push({
            agent,
            status: "missing",
            path: targets[agent],
            blockMatches: false,
            rulesCurrent: false,
          });
          continue;
        }
        const found = yield* Files.verify(delivery.target_path, id);
        const blockMatches = found.kind === "found" && found.hash === delivery.rendered_hash;
        if (blockMatches) {
          yield* sql`
            UPDATE deliveries SET verified_at = ${at}, verification_method = 'reread_hash'
            WHERE project_id = ${projectId} AND "key" = ${key} AND agent = ${agent}
          `;
        }
        results.push({
          agent,
          status: blockMatches ? "ok" : found.kind === "absent" ? "missing" : "drifted",
          path: delivery.target_path,
          blockMatches,
          rulesCurrent: delivery.rules_hash === rulesHash,
        });
      }
      return results;
    },
    // Under the install lock, so a verify never reads a file one install is replacing and
    // marks the delivery row that install writes next.
    installLock.withPermits(1),
    provided,
    Effect.catchTags({
      SqlError: io("Could not record the verification."),
      PlatformError: io("Could not read an instruction file."),
      ServerSettingsError: io("Could not read the server settings."),
    }),
  );

  const list = Effect.fn("PolicyService.list")(
    function* (projectId: ProjectId) {
      const scope = sql.in("project_id", [projectId, POLICY_ENVIRONMENT_PROJECT_ID]);
      const policies = yield* sql<PolicyRow>`
        SELECT * FROM policies WHERE ${scope} ORDER BY project_id, "key"
      `;
      const deliveries = yield* sql<DeliveryRow>`
        SELECT * FROM deliveries WHERE ${scope} ORDER BY agent
      `;
      return policies.map((policy): PolicyListing => ({
        projectId: policy.project_id,
        key: policy.key,
        title: policy.title,
        version: policy.version,
        state: policy.state,
        updatedAt: policy.updated_at,
        deliveries: deliveries
          .filter((row) => row.project_id === policy.project_id && row.key === policy.key)
          .map((row) => ({
            agent: row.agent,
            version: row.version,
            path: row.target_path,
            installedAt: row.installed_at,
            verifiedAt: row.verified_at,
          })),
      }));
    },
    Effect.catchTags({ SqlError: io("Could not read the policies.") }),
  );

  return PolicyService.of({ create, accept, install, verify, list });
});

export const layer = Layer.effect(PolicyService, make);
