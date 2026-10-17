import {
  POLICY_AGENTS,
  POLICY_ENVIRONMENT_PROJECT_ID,
  PolicyError,
  PolicyKey,
  type PolicyAcceptInput,
  type PolicyAgent,
  type PolicyAgentsInput,
  type PolicyCreateInput,
  type PolicyDeliveryStatus,
  type PolicyInstallResult,
  type PolicyListing,
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
import * as Blocks from "../InstructionBlocks.ts";
import * as Files from "./InstructionFiles.ts";
import { blockId, policyMarkers, renderBlock } from "./Render.ts";

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

/** One policy with the rows `list` and `listWithStatus` build from: its versions and deliveries. */
interface ListedPolicy {
  readonly policy: PolicyRow;
  /** Each version in its latest state, earliest first. */
  readonly versions: ReadonlyArray<VersionRow & { readonly at: string }>;
  readonly deliveries: ReadonlyArray<DeliveryRow>;
}

export class PolicyService extends Context.Service<
  PolicyService,
  {
    /** Appends the next version as a draft. */
    readonly create: (input: PolicyCreateInput) => Effect.Effect<PolicyVersionRef, PolicyError>;
    /**
     * `create` for a learning promotion, once per `promotionId`: the draft and the record of it
     * commit together, and a repeat finds the record and writes nothing.
     */
    readonly createForPromotion: (
      input: PolicyCreateInput,
      promotionId: number,
    ) => Effect.Effect<void, PolicyError>;
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
    /**
     * The project's policies and the environment-wide ones, each with its versions and recorded
     * deliveries. It reads only the database, so an instruction file that cannot be read cannot
     * fail it: the `policy_list` tool and the startup seeders use it.
     */
    readonly list: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<Omit<PolicyListing, "status">>, PolicyError>;
    /**
     * `list` with every agent's file re-read now, each file once however many policies it holds.
     * Unlike `verify` it marks nothing verified and takes no lock, so a read during an install can
     * show a block as drifted until the next one. It also tells an intact block of another version
     * than the accepted one (`outdated`), which `verify` does not. The gateway's `policy.list`.
     */
    readonly listWithStatus: (
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
  const readRules = Effect.map(Blocks.read(rulesPath), (text) => text ?? "");

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

  /** Refuses what a policy block could not hold. */
  const checkDraft = Effect.fn("PolicyService.checkDraft")(function* ({
    projectId,
    key,
    body,
  }: PolicyCreateInput) {
    if (!isKey(key)) return yield* invalid(`Policy key "${key}" must match [a-z0-9-]+.`);
    if (!isMarkerSafe(projectId)) {
      return yield* invalid(`Project id "${projectId}" cannot be placed in a policy marker.`);
    }
    if (body.includes("fork-policy:")) {
      return yield* invalid('A policy body cannot contain "fork-policy:".');
    }
  });

  /** Appends the next version as a draft; the caller holds the transaction. */
  const appendDraft = ({ projectId, key, title, body }: PolicyCreateInput, at: string) =>
    Effect.gen(function* () {
      const version = Math.max(0, ...(yield* versionsOf(projectId, key)).keys()) + 1;
      yield* appendVersion(projectId, key, { version, state: "draft", title, body }, at);
      yield* refreshPolicy(projectId, key, at);
      return { key, version, state: "draft" } satisfies PolicyVersionRef;
    });

  const create = Effect.fn("PolicyService.create")(
    function* (input: PolicyCreateInput) {
      yield* checkDraft(input);
      const at = yield* nowIso;
      return yield* sql.withTransaction(appendDraft(input, at));
    },
    Effect.catchTags({ SqlError: io("Could not save the policy.") }),
  );

  const createForPromotion = Effect.fn("PolicyService.createForPromotion")(
    function* (input: PolicyCreateInput, promotionId: number) {
      yield* checkDraft(input);
      const at = yield* nowIso;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const done =
            yield* sql`SELECT 1 FROM policy_promotion WHERE promotion_id = ${promotionId}`;
          if (done.length > 0) return;
          const { key, version } = yield* appendDraft(input, at);
          yield* sql`INSERT INTO policy_promotion ${sql.insert({
            promotion_id: promotionId,
            project_id: input.projectId,
            key,
            version,
          })}`;
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
      const targets = yield* Blocks.targets();
      // Every file is read before any is written, so a damaged block refuses the whole install.
      const plans: Array<{ agent: PolicyAgent; path: string; next: string | undefined }> = [];
      for (const agent of agents) {
        const filePath = targets[agent];
        if (!(yield* fs.exists(path.dirname(filePath)))) {
          plans.push({ agent, path: filePath, next: undefined });
          continue;
        }
        const text = (yield* Blocks.read(filePath)) ?? "";
        const found = Blocks.findBlock(text, policyMarkers(id));
        if (found.kind === "damaged") {
          return yield* invalid(
            `${filePath} has a damaged fork-policy block for "${key}". Fix or remove it by hand.`,
          );
        }
        plans.push({ agent, path: filePath, next: Blocks.placeBlock(text, found, block.text) });
      }
      const at = yield* nowIso;
      if (beforeWrite !== undefined) yield* beforeWrite;
      const results: Array<PolicyInstallResult> = [];
      for (const plan of plans) {
        if (plan.next !== undefined) {
          yield* Blocks.write(plan.path, plan.next);
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

  /**
   * The delivery if it went into the file the agent reads now. One into another file, such as the
   * agent's old home, counts as none, as `needsDelivery` has it, so the agent shows as missing
   * where it reads now.
   */
  const intoCurrentFile = (
    targets: Record<PolicyAgent, string>,
    delivery: DeliveryRow | undefined,
  ) =>
    delivery !== undefined && delivery.target_path === targets[delivery.agent]
      ? delivery
      : undefined;

  /**
   * One agent's delivery against the text of the file it went into; an agent never delivered to is
   * missing. `text` is that file's contents, undefined when there is no such file, so a caller
   * checking many blocks reads each file once.
   */
  const inspect = (input: {
    readonly id: string;
    readonly rulesHash: string;
    readonly agent: PolicyAgent;
    readonly targetPath: string;
    readonly delivery: DeliveryRow | undefined;
    readonly text: string | undefined;
  }) => {
    const { agent, delivery, text } = input;
    if (delivery === undefined) {
      return {
        agent,
        status: "missing",
        path: input.targetPath,
        blockMatches: false,
        rulesCurrent: false,
      } satisfies PolicyVerifyResult;
    }
    const found =
      text === undefined
        ? ({ kind: "absent" } as const)
        : Blocks.findBlock(text, policyMarkers(input.id));
    const blockMatches = found.kind === "found" && found.hash === delivery.rendered_hash;
    return {
      agent,
      status: blockMatches ? "ok" : found.kind === "absent" ? "missing" : "drifted",
      path: delivery.target_path,
      blockMatches,
      rulesCurrent: delivery.rules_hash === input.rulesHash,
    } satisfies PolicyVerifyResult;
  };

  const verify = Effect.fn("PolicyService.verify")(
    function* ({ projectId, key, agents = POLICY_AGENTS }: PolicyAgentsInput) {
      const id = blockId(projectId, key);
      const rulesHash = Blocks.sha256(yield* readRules);
      const deliveries = new Map(
        (yield* sql<DeliveryRow>`
          SELECT * FROM deliveries WHERE project_id = ${projectId} AND "key" = ${key}
        `).map((row) => [row.agent, row]),
      );
      const targets = yield* Blocks.targets();
      const at = yield* nowIso;
      const results: Array<PolicyVerifyResult> = [];
      for (const agent of agents) {
        const delivery = intoCurrentFile(targets, deliveries.get(agent));
        const result = inspect({
          id,
          rulesHash,
          agent,
          targetPath: targets[agent],
          delivery,
          text: delivery === undefined ? undefined : yield* Blocks.read(delivery.target_path),
        });
        if (result.blockMatches) {
          yield* sql`
            UPDATE deliveries SET verified_at = ${at}, verification_method = 'reread_hash'
            WHERE project_id = ${projectId} AND "key" = ${key} AND agent = ${agent}
          `;
        }
        results.push(result);
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

  /** The scope's policies, each with its versions and recorded deliveries. Reads only the database. */
  const rowsOf = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const scope = sql.in("project_id", [projectId, POLICY_ENVIRONMENT_PROJECT_ID]);
      const policies = yield* sql<PolicyRow>`
        SELECT * FROM policies WHERE ${scope} ORDER BY project_id, "key"
      `;
      if (policies.length === 0) return [];
      const versions = yield* sql<
        VersionRow & { readonly project_id: ProjectId; readonly key: string; readonly at: string }
      >`
        SELECT project_id, "key", version, state, title, at FROM policy_versions
        WHERE ${scope} ORDER BY id
      `;
      const deliveries = yield* sql<DeliveryRow>`
        SELECT * FROM deliveries WHERE ${scope} ORDER BY agent
      `;
      // Rows are grouped by policy once, so each policy takes its own without scanning the rest.
      // A key never holds "/", so the project id and key cannot run together.
      const ownerOf = (row: { readonly project_id: ProjectId; readonly key: string }) =>
        `${row.project_id}/${row.key}`;
      const versionRows = Map.groupBy(versions, ownerOf);
      const deliveryRows = Map.groupBy(deliveries, ownerOf);
      return policies.map((policy): ListedPolicy => {
        const owner = ownerOf(policy);
        // Ordered by id, so the last row for a version is its state.
        const byVersion = new Map((versionRows.get(owner) ?? []).map((row) => [row.version, row]));
        return {
          policy,
          versions: [...byVersion.values()],
          deliveries: deliveryRows.get(owner) ?? [],
        };
      });
    });

  const recordOf = ({ policy, versions, deliveries }: ListedPolicy) =>
    ({
      projectId: policy.project_id,
      key: policy.key,
      title: policy.title,
      body: policy.body,
      version: policy.version,
      state: policy.state,
      updatedAt: policy.updated_at,
      versions: versions.map((row) => ({
        version: row.version,
        state: row.state,
        title: row.title,
        at: row.at,
      })),
      deliveries: deliveries.map((row) => ({
        agent: row.agent,
        version: row.version,
        path: row.target_path,
        installedAt: row.installed_at,
        verifiedAt: row.verified_at,
      })),
    }) satisfies Omit<PolicyListing, "status">;

  const list = Effect.fn("PolicyService.list")(
    function* (projectId: ProjectId) {
      return (yield* rowsOf(projectId)).map(recordOf);
    },
    Effect.catchTags({ SqlError: io("Could not read the policies.") }),
  );

  const listWithStatus = Effect.fn("PolicyService.listWithStatus")(
    function* (projectId: ProjectId) {
      const listed = yield* rowsOf(projectId);
      if (listed.length === 0) return [];
      const targets = yield* Blocks.targets();
      const rulesHash = Blocks.sha256(yield* readRules);
      // An instruction file holds every policy's block, so each file the deliveries went into is
      // read once here and every block is found in that text.
      const texts = new Map<string, string | undefined>();
      const filePaths = new Set(
        listed.flatMap(({ deliveries }) =>
          deliveries.flatMap((row) => intoCurrentFile(targets, row)?.target_path ?? []),
        ),
      );
      for (const filePath of filePaths) texts.set(filePath, yield* Blocks.read(filePath));
      return listed.map((row) => {
        const { policy } = row;
        const id = blockId(policy.project_id, policy.key);
        const status = POLICY_AGENTS.map((agent): PolicyDeliveryStatus => {
          const delivery = intoCurrentFile(
            targets,
            row.deliveries.find((candidate) => candidate.agent === agent),
          );
          const result = inspect({
            id,
            rulesHash,
            agent,
            targetPath: targets[agent],
            delivery,
            text: delivery === undefined ? undefined : texts.get(delivery.target_path),
          });
          // An intact block still hashes as installed after a newer version is accepted, so `ok`
          // alone would hide that the file holds another version than the accepted one.
          return result.status === "ok" &&
            policy.state === "accepted" &&
            delivery?.version !== policy.version
            ? { ...result, status: "outdated" }
            : result;
        });
        return { ...recordOf(row), status } satisfies PolicyListing;
      });
    },
    provided,
    Effect.catchTags({
      SqlError: io("Could not read the policies."),
      PlatformError: io("Could not read an instruction file."),
      ServerSettingsError: io("Could not read the server settings."),
    }),
  );

  return PolicyService.of({
    create,
    createForPromotion,
    accept,
    install,
    verify,
    list,
    listWithStatus,
  });
});

export const layer = Layer.effect(PolicyService, make);
