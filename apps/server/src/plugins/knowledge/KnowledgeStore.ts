import {
  KnowledgeBody,
  KnowledgeError,
  KnowledgeKey,
  KnowledgeSource,
  KnowledgeState,
  KnowledgeTitle,
  KNOWLEDGE_MARKER_WORD,
  knowledgePagePath,
  POLICY_AGENTS,
  ProjectId,
  type KnowledgeAcceptInput,
  type KnowledgeEntry,
  type KnowledgeInstallResult,
  type KnowledgeListInput,
  type KnowledgeProjectInput,
  type KnowledgeProposeInput,
  type KnowledgeIdInput,
  type KnowledgeVerifyResult,
  type PolicyAgent,
  type ServerSettingsError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";

import * as ProjectService from "../../project/ProjectService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as Blocks from "../InstructionBlocks.ts";
import * as Pages from "./Pages.ts";

const EntryRow = Schema.Struct({
  id: Schema.Int,
  projectId: ProjectId,
  key: Schema.String,
  title: Schema.String,
  body: Schema.String,
  state: KnowledgeState,
  source: Schema.fromJsonString(KnowledgeSource),
  createdAt: Schema.String,
  acceptedAt: Schema.NullOr(Schema.String),
  retiredAt: Schema.NullOr(Schema.String),
});
const encodeSource = Schema.encodeEffect(Schema.fromJsonString(KnowledgeSource));

/**
 * Each thing an install writes has a delivery row holding the hash of what it wrote: an agent in
 * use for its index block, and `page:<key>` for each page file, whatever agents are in use. The
 * sweep compares a file with its row to tell what it wrote from what a person edited.
 */
interface DeliveryRow {
  readonly agent: string;
  readonly path: string;
  readonly hash: string;
}

const PAGE_DELIVERY = "page:";
const pageDelivery = (key: string) => `${PAGE_DELIVERY}${key}`;

/** sha256 of a file's text, or undefined when there is no file. */
const fileHash = (text: string | undefined) =>
  text === undefined ? undefined : Blocks.sha256(text);

/** One thing an install records, and what the sweep does about it. */
interface Component {
  /** Its delivery row's `agent`. */
  readonly id: string;
  readonly path: string;
  /** The hash it renders to now; undefined when it should not exist. */
  readonly expected: string | undefined;
  /** The file's text once it is written; undefined when the file goes. */
  readonly next: string | undefined;
  readonly action: Pages.CatchUp;
}

/**
 * One recorded delivery against the hash its install recorded. `removed` is a file, or an index
 * block, that is gone; `edited` one that holds something else, a damaged block included.
 */
export interface KnowledgeDrift {
  /** The delivery row's `agent`: `page:<key>`, or the agent whose index block it is. */
  readonly id: string;
  /** The page's key; undefined for an agent's index block. */
  readonly page: string | undefined;
  readonly path: string;
  readonly status: "ok" | "edited" | "removed";
}

export class KnowledgeStore extends Context.Service<
  KnowledgeStore,
  {
    /** The project's pages, by key; only those in `state` when given. */
    readonly list: (
      input: KnowledgeListInput,
    ) => Effect.Effect<ReadonlyArray<KnowledgeEntry>, KnowledgeError>;
    /**
     * Saves a draft for a project the server knows; an unknown one is `not_found`. Nothing is
     * written to the project until a person accepts it.
     */
    readonly propose: (
      input: KnowledgeProposeInput,
      source: KnowledgeSource,
    ) => Effect.Effect<KnowledgeEntry, KnowledgeError>;
    /**
     * Accepts a draft, with the edits given, then installs the project. The move from draft is one
     * statement, so of two requests for one draft the second is refused.
     */
    readonly accept: (input: KnowledgeAcceptInput) => Effect.Effect<KnowledgeEntry, KnowledgeError>;
    /**
     * Retires an accepted page, then installs the project. Like `accept`, the move is one
     * statement, so a page another request moved first is refused.
     */
    readonly retire: (input: KnowledgeIdInput) => Effect.Effect<KnowledgeEntry, KnowledgeError>;
    /** Discards a draft, which was never written, so nothing is installed; it is kept as retired. */
    readonly discard: (input: KnowledgeIdInput) => Effect.Effect<KnowledgeEntry, KnowledgeError>;
    /**
     * A person's install: writes every accepted page, removes retired ones, and rewrites the index
     * block in the project instruction file of each agent in use, hand edits included; a file whose
     * bytes would not change is not written.
     */
    readonly install: (
      input: KnowledgeProjectInput,
    ) => Effect.Effect<ReadonlyArray<KnowledgeInstallResult>, KnowledgeError>;
    /** Re-reads the project's pages and each agent's index block against what renders now. */
    readonly verify: (
      input: KnowledgeProjectInput,
    ) => Effect.Effect<ReadonlyArray<KnowledgeVerifyResult>, KnowledgeError>;
    /**
     * Each delivery an install keeps current, a page file or an index block of an agent in use,
     * against the hash that install recorded, so a file still waiting for the sweep to catch up is
     * intact and only a file changed outside T3 Code is not. Nothing is written or marked verified.
     * A page that was never delivered has no entry.
     */
    readonly drift: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<KnowledgeDrift>, KnowledgeError>;
    /**
     * Whether the sweep has something to catch up on: a page file or an agent's index block whose
     * delivery is not what the accepted pages render to now, and that still holds what was
     * delivered. One a person edited is left out; it stays drifted until a person reinstalls.
     */
    readonly outdated: (projectId: ProjectId) => Effect.Effect<boolean, KnowledgeError>;
    /**
     * The sweep's install: writes only what `outdated` names and records it, leaving every other
     * file as it is. `beforeWrite` runs under the install lock right before the first write, and
     * failing it cancels with nothing written. False when nothing was due.
     */
    readonly catchUp: (
      projectId: ProjectId,
      beforeWrite?: Effect.Effect<void, KnowledgeError>,
    ) => Effect.Effect<boolean, KnowledgeError>;
  }
>()("t3/plugins/knowledge/KnowledgeStore") {}

const invalid = (message: string) => new KnowledgeError({ code: "invalid", message });
const isKey = Schema.is(KnowledgeKey);
const isTitle = Schema.is(KnowledgeTitle);
const isBody = Schema.is(KnowledgeBody);

/** Database, file, settings and project failures are logged in full; the caller hears which step failed. */
const io =
  (message: string) =>
  (
    cause:
      | SqlError.SqlError
      | Schema.SchemaError
      | PlatformError.PlatformError
      | ServerSettingsError
      | ProjectService.ProjectOperationError,
  ) =>
    Effect.logWarning(message, { cause }).pipe(
      Effect.andThen(Effect.fail(new KnowledgeError({ code: "io", message }))),
    );

/** A title or body the contract's schemas refuse, the index block's marker text among them. */
const checkText = (title: string | undefined, body: string | undefined) => {
  if (title !== undefined && !isTitle(title)) {
    return Effect.fail(
      invalid(`A title is one line of at most 200 characters without "${KNOWLEDGE_MARKER_WORD}".`),
    );
  }
  if (body !== undefined && !isBody(body)) {
    return Effect.fail(invalid("A body is between 1 and 4,000 characters."));
  }
  return Effect.void;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const provided = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideContext(effect, platform);
  /** Installs read the files they rewrite, so two at once would drop one's change; verify shares it. */
  const installLock = yield* Semaphore.make(1);
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  /** Every page of the project, by key; a project holds a handful. */
  const entries = SqlSchema.findAll({
    Request: Schema.String,
    Result: EntryRow,
    execute: (projectId) => sql`
      SELECT id, project_id AS "projectId", "key", title, body, state, source,
        created_at AS "createdAt", accepted_at AS "acceptedAt", retired_at AS "retiredAt"
      FROM knowledge_entry WHERE project_id = ${projectId} ORDER BY "key", id
    `,
  });
  const entryRow = SqlSchema.findOneOption({
    Request: Schema.Int,
    Result: EntryRow,
    execute: (id) => sql`
      SELECT id, project_id AS "projectId", "key", title, body, state, source,
        created_at AS "createdAt", accepted_at AS "acceptedAt", retired_at AS "retiredAt"
      FROM knowledge_entry WHERE id = ${id}
    `,
  });
  /** Accepts the row only while it is a draft, in the one statement that reads and moves it. */
  const acceptRow = SqlSchema.findOneOption({
    Request: Schema.Struct({
      id: Schema.Int,
      title: Schema.NullOr(Schema.String),
      body: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
    Result: EntryRow,
    execute: ({ id, title, body, at }) => sql`
      UPDATE knowledge_entry
      SET state = 'accepted', title = COALESCE(${title}, title), body = COALESCE(${body}, body),
        accepted_at = ${at}
      WHERE id = ${id} AND state = 'draft'
      RETURNING id, project_id AS "projectId", "key", title, body, state, source,
        created_at AS "createdAt", accepted_at AS "acceptedAt", retired_at AS "retiredAt"
    `,
  });
  /** Moves the row from `from` to retired, only while it is still there, in one statement. */
  const retireRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ id: Schema.Int, from: KnowledgeState, at: Schema.String }),
    Result: EntryRow,
    execute: ({ id, from, at }) => sql`
      UPDATE knowledge_entry SET state = 'retired', retired_at = ${at}
      WHERE id = ${id} AND state = ${from}
      RETURNING id, project_id AS "projectId", "key", title, body, state, source,
        created_at AS "createdAt", accepted_at AS "acceptedAt", retired_at AS "retiredAt"
    `,
  });
  const entryById = (id: number) =>
    Effect.flatMap(
      entryRow(id),
      Option.match({
        onNone: () =>
          Effect.fail(
            new KnowledgeError({ code: "not_found", message: `Page ${id} was not found.` }),
          ),
        onSome: Effect.succeed,
      }),
    );

  /** Why a transition moved nothing: the page is gone, or it is not in the state `only` names. */
  const refused = (id: number, only: string) =>
    Effect.flatMap(entryById(id), (entry) =>
      Effect.fail(invalid(`Page "${entry.key}" is ${entry.state}; only ${only}.`)),
    );

  /** The project's root, from the host's project service where the call runs. */
  const projectRoot = Effect.fn("KnowledgeStore.projectRoot")(function* (projectId: ProjectId) {
    const projects = yield* Effect.serviceOption(ProjectService.ProjectService);
    if (Option.isNone(projects)) {
      return yield* new KnowledgeError({ code: "io", message: "Projects are not available." });
    }
    const project = yield* projects.value.getById(projectId);
    if (Option.isNone(project)) {
      return yield* new KnowledgeError({
        code: "not_found",
        message: `Project "${projectId}" was not found.`,
      });
    }
    return project.value.workspaceRoot;
  });

  /** Agents whose home directory exists, resolved as the policy plugin resolves them. */
  const agentsInUse = Effect.fn("KnowledgeStore.agentsInUse")(function* () {
    const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
    if (Option.isNone(settings)) {
      return yield* new KnowledgeError({
        code: "io",
        message: "Server settings are not available.",
      });
    }
    const targets = yield* Blocks.targets().pipe(
      Effect.provideService(ServerSettings.ServerSettingsService, settings.value),
    );
    return yield* Effect.filter(POLICY_AGENTS, (agent) => fs.exists(path.dirname(targets[agent])));
  });

  /** What an install of the project writes, and where. */
  const planOf = Effect.fn("KnowledgeStore.planOf")(function* (projectId: ProjectId) {
    const all = yield* entries(projectId);
    const accepted = all.filter((entry) => entry.state === "accepted");
    const live = new Set(accepted.map((entry) => entry.key));
    const root = yield* projectRoot(projectId);
    const agents = yield* agentsInUse();
    return {
      rendered: Pages.render(accepted),
      pageFile: (relative: string) => path.join(root, relative),
      agents: agents.map((agent) => ({
        agent,
        path: path.join(root, Pages.PROJECT_INSTRUCTION_FILES[agent]),
      })),
      /** Files of retired pages whose key no accepted page has taken since. */
      retired: [
        ...new Set(
          all
            .filter((entry) => entry.state === "retired" && !live.has(entry.key))
            .map((entry) => path.join(root, knowledgePagePath(entry.key))),
        ),
      ],
    };
  });

  const deliveriesOf = (projectId: ProjectId) =>
    Effect.map(
      sql<DeliveryRow>`
        SELECT agent, path, hash FROM knowledge_delivery WHERE project_id = ${projectId}
      `,
      (rows) => new Map(rows.map((row) => [row.agent, row])),
    );

  /**
   * Saves each component's delivery: the hash it was written with, or no row once it should not
   * exist. Components the call does not name keep their rows.
   */
  const record = Effect.fn("KnowledgeStore.record")(function* (
    projectId: ProjectId,
    components: ReadonlyArray<Pick<Component, "id" | "path" | "expected">>,
  ) {
    const at = yield* nowIso;
    const delivered = yield* deliveriesOf(projectId);
    for (const { id, path: filePath, expected } of components) {
      const row = delivered.get(id);
      if (expected === undefined) {
        if (row !== undefined) {
          yield* sql`DELETE FROM knowledge_delivery WHERE project_id = ${projectId} AND agent = ${id}`;
        }
        continue;
      }
      if (row?.hash === expected && row.path === filePath) continue;
      yield* sql`INSERT OR REPLACE INTO knowledge_delivery ${sql.insert({
        project_id: projectId,
        agent: id,
        path: filePath,
        hash: expected,
        installed_at: at,
        verified_at: null,
      })}`;
    }
  });

  /** A person's install: every component is written as it renders now, hand edits included. */
  const install = Effect.fn("KnowledgeStore.install")(
    function* ({ projectId }: KnowledgeProjectInput) {
      const plan = yield* planOf(projectId);
      const { rendered } = plan;
      // Every file is read before any is written, so a damaged block refuses the whole install.
      const writes: Array<{ readonly path: string; readonly text: string }> = [];
      const removals: Array<string> = [];
      for (const page of rendered.pages) {
        const filePath = plan.pageFile(page.path);
        if ((yield* Blocks.read(filePath)) !== page.text) {
          writes.push({ path: filePath, text: page.text });
        }
      }
      for (const filePath of plan.retired) {
        if (yield* fs.exists(filePath)) removals.push(filePath);
      }
      const changed = new Set<PolicyAgent>();
      for (const { agent, path: filePath } of plan.agents) {
        const text = yield* Blocks.read(filePath);
        const found = Blocks.findBlock(text ?? "", Pages.INDEX_MARKERS);
        if (found.kind === "damaged") {
          return yield* invalid(
            `${filePath} has a damaged fork-knowledge block. Fix or remove it by hand.`,
          );
        }
        const next =
          rendered.block !== undefined
            ? Blocks.placeBlock(text ?? "", found, rendered.block.text)
            : found.kind === "found"
              ? Blocks.removeBlock(text ?? "", found)
              : text;
        if (next === text || next === undefined) continue;
        changed.add(agent);
        // A file that held the block alone goes with it, as it came with it.
        if (next === "") removals.push(filePath);
        else writes.push({ path: filePath, text: next });
      }
      for (const write of writes) yield* Blocks.write(write.path, write.text);
      for (const filePath of removals) yield* fs.remove(filePath);

      const live = new Set(rendered.pages.map((page) => pageDelivery(page.key)));
      const gone = [...(yield* deliveriesOf(projectId)).values()].filter(
        (row) => row.agent.startsWith(PAGE_DELIVERY) && !live.has(row.agent),
      );
      yield* record(projectId, [
        ...rendered.pages.map((page) => ({
          id: pageDelivery(page.key),
          path: plan.pageFile(page.path),
          expected: page.hash,
        })),
        ...gone.map((row) => ({ id: row.agent, path: row.path, expected: undefined })),
        ...plan.agents.map(({ agent, path: filePath }) => ({
          id: agent,
          path: filePath,
          expected: rendered.block?.hash,
        })),
      ]);
      return plan.agents.map(({ agent, path: filePath }): KnowledgeInstallResult => ({
        agent,
        status: changed.has(agent) ? "installed" : "unchanged",
        path: filePath,
      }));
    },
    installLock.withPermits(1),
    provided,
    Effect.catchTags({
      SqlError: io("Could not record the install."),
      SchemaError: io("Could not read the pages."),
      PlatformError: io("Could not write the project's knowledge files."),
      ServerSettingsError: io("Could not read the server settings."),
      ProjectOperationError: io("Could not read the project."),
    }),
  );

  const verify = Effect.fn("KnowledgeStore.verify")(
    function* ({ projectId }: KnowledgeProjectInput) {
      const plan = yield* planOf(projectId);
      const { rendered } = plan;
      let pages: KnowledgeVerifyResult["status"] = "ok";
      for (const page of rendered.pages) {
        const text = yield* Blocks.read(plan.pageFile(page.path));
        pages = Pages.worse(pages, Pages.pageStatus(text, page.text));
      }
      for (const filePath of plan.retired) {
        if (yield* fs.exists(filePath)) pages = Pages.worse(pages, "drifted");
      }
      const at = yield* nowIso;
      const results: Array<KnowledgeVerifyResult> = [];
      for (const { agent, path: filePath } of plan.agents) {
        const text = yield* Blocks.read(filePath);
        const found: Blocks.FoundBlock =
          text === undefined ? { kind: "absent" } : Blocks.findBlock(text, Pages.INDEX_MARKERS);
        const status = Pages.worse(pages, Pages.blockStatus(rendered.block?.hash, found));
        if (status === "ok") {
          yield* sql`
            UPDATE knowledge_delivery SET verified_at = ${at}
            WHERE project_id = ${projectId} AND agent = ${agent}
          `;
        }
        results.push({ agent, status, path: filePath });
      }
      return results;
    },
    // Under the install lock, so a verify never reads a file one install is replacing.
    installLock.withPermits(1),
    provided,
    Effect.catchTags({
      SqlError: io("Could not record the verification."),
      SchemaError: io("Could not read the pages."),
      PlatformError: io("Could not read the project's knowledge files."),
      ServerSettingsError: io("Could not read the server settings."),
      ProjectOperationError: io("Could not read the project."),
    }),
  );

  const drift = Effect.fn("KnowledgeStore.drift")(
    function* (projectId: ProjectId) {
      const plan = yield* planOf(projectId);
      const delivered = yield* deliveriesOf(projectId);
      const results: Array<KnowledgeDrift> = [];
      for (const page of plan.rendered.pages) {
        const row = delivered.get(pageDelivery(page.key));
        if (row === undefined) continue;
        const current = fileHash(yield* Blocks.read(row.path));
        results.push({
          id: row.agent,
          page: page.key,
          path: row.path,
          status: current === undefined ? "removed" : current === row.hash ? "ok" : "edited",
        });
      }
      for (const { agent } of plan.agents) {
        const row = delivered.get(agent);
        if (row === undefined) continue;
        const text = yield* Blocks.read(row.path);
        const found: Blocks.FoundBlock =
          text === undefined ? { kind: "absent" } : Blocks.findBlock(text, Pages.INDEX_MARKERS);
        results.push({
          id: row.agent,
          page: undefined,
          path: row.path,
          status:
            found.kind === "found" && found.hash === row.hash
              ? "ok"
              : found.kind === "absent"
                ? "removed"
                : "edited",
        });
      }
      return results;
    },
    // Under the install lock, so a read never lands between an install's write and its record.
    installLock.withPermits(1),
    provided,
    Effect.catchTags({
      SqlError: io("Could not read the deliveries."),
      SchemaError: io("Could not read the pages."),
      PlatformError: io("Could not read the project's knowledge files."),
      ServerSettingsError: io("Could not read the server settings."),
      ProjectOperationError: io("Could not read the project."),
    }),
  );

  /** Every component of the project, with the sweep's decision for each. */
  const componentsOf = Effect.fn("KnowledgeStore.componentsOf")(function* (projectId: ProjectId) {
    const plan = yield* planOf(projectId);
    const { rendered } = plan;
    const delivered = yield* deliveriesOf(projectId);
    const decide = (
      id: string,
      filePath: string,
      expected: string | undefined,
      current: string | undefined,
    ) => Pages.catchUp({ expected, current, path: filePath, delivery: delivered.get(id) });
    const components: Array<Component> = [];
    for (const page of rendered.pages) {
      const id = pageDelivery(page.key);
      const filePath = plan.pageFile(page.path);
      const current = fileHash(yield* Blocks.read(filePath));
      components.push({
        id,
        path: filePath,
        expected: page.hash,
        next: page.text,
        action: decide(id, filePath, page.hash, current),
      });
    }
    // A page recorded but no longer accepted: its file goes, unless a person edited it since.
    const live = new Set(components.map((component) => component.id));
    for (const row of delivered.values()) {
      if (!row.agent.startsWith(PAGE_DELIVERY) || live.has(row.agent)) continue;
      const current = fileHash(yield* Blocks.read(row.path));
      components.push({
        id: row.agent,
        path: row.path,
        expected: undefined,
        next: undefined,
        action: decide(row.agent, row.path, undefined, current),
      });
    }
    for (const { agent, path: filePath } of plan.agents) {
      const text = yield* Blocks.read(filePath);
      const found = Blocks.findBlock(text ?? "", Pages.INDEX_MARKERS);
      const expected = rendered.block?.hash;
      const next =
        found.kind === "damaged"
          ? text
          : rendered.block !== undefined
            ? Blocks.placeBlock(text ?? "", found, rendered.block.text)
            : found.kind === "found"
              ? Blocks.removeBlock(text ?? "", found)
              : text;
      components.push({
        id: agent,
        path: filePath,
        expected,
        // A file that held the block alone goes with it, as it came with it.
        next: next === "" ? undefined : next,
        // A damaged block is a person's to fix, as a hand edit is.
        action:
          found.kind === "damaged"
            ? "leave"
            : decide(agent, filePath, expected, found.kind === "found" ? found.hash : undefined),
      });
    }
    return components;
  });

  const due = (component: Component) =>
    component.action === "write" || component.action === "record";

  const outdated = Effect.fn("KnowledgeStore.outdated")(
    function* (projectId: ProjectId) {
      return (yield* componentsOf(projectId)).some(due);
    },
    provided,
    Effect.catchTags({
      SqlError: io("Could not read the deliveries."),
      SchemaError: io("Could not read the pages."),
      PlatformError: io("Could not read the project's knowledge files."),
      ServerSettingsError: io("Could not read the server settings."),
      ProjectOperationError: io("Could not read the project."),
    }),
  );

  const catchUp = Effect.fn("KnowledgeStore.catchUp")(
    function* (projectId: ProjectId, beforeWrite?: Effect.Effect<void, KnowledgeError>) {
      const components = (yield* componentsOf(projectId)).filter(due);
      if (components.length === 0) return false;
      if (beforeWrite !== undefined) yield* beforeWrite;
      for (const component of components) {
        if (component.action !== "write") continue;
        if (component.next !== undefined) yield* Blocks.write(component.path, component.next);
        else if (yield* fs.exists(component.path)) yield* fs.remove(component.path);
      }
      yield* record(projectId, components);
      return true;
    },
    installLock.withPermits(1),
    provided,
    Effect.catchTags({
      SqlError: io("Could not record the install."),
      SchemaError: io("Could not read the pages."),
      PlatformError: io("Could not write the project's knowledge files."),
      ServerSettingsError: io("Could not read the server settings."),
      ProjectOperationError: io("Could not read the project."),
    }),
  );

  /** Installs after a person changed what is accepted; a failure says the change itself stands. */
  const installAfter = (entry: KnowledgeEntry, done: string) =>
    install({ projectId: entry.projectId }).pipe(
      Effect.catchTags({
        KnowledgeError: (error) =>
          Effect.fail(
            new KnowledgeError({
              code: error.code,
              message: `Page "${entry.key}" is ${done}, but the install failed: ${error.message}`,
            }),
          ),
      }),
    );

  const list = Effect.fn("KnowledgeStore.list")(
    function* ({ projectId, state }: KnowledgeListInput) {
      const all = yield* entries(projectId);
      return state === undefined ? all : all.filter((entry) => entry.state === state);
    },
    Effect.catchTags({
      SqlError: io("Could not read the pages."),
      SchemaError: io("Could not read the pages."),
    }),
  );

  const propose = Effect.fn("KnowledgeStore.propose")(
    function* (input: KnowledgeProposeInput, source: KnowledgeSource) {
      if (!isKey(input.key)) {
        return yield* invalid(`Key "${input.key}" must match [a-z0-9][a-z0-9-]{0,63}.`);
      }
      yield* checkText(input.title, input.body);
      // A draft names a project the server knows, so accepting it has somewhere to install.
      yield* projectRoot(input.projectId);
      const encodedSource = yield* encodeSource(source);
      const at = yield* nowIso;
      const id = yield* sql.withTransaction(
        Effect.gen(function* () {
          const taken = yield* sql<{ readonly state: string }>`
            SELECT state FROM knowledge_entry
            WHERE project_id = ${input.projectId} AND "key" = ${input.key} AND state <> 'retired'
          `;
          if (taken[0] !== undefined) {
            return yield* invalid(
              `This project already has a ${taken[0].state} page "${input.key}".`,
            );
          }
          const [row] = yield* sql<{ readonly id: number }>`
            INSERT INTO knowledge_entry ${sql.insert({
              project_id: input.projectId,
              key: input.key,
              title: input.title,
              body: input.body,
              state: "draft",
              source: encodedSource,
              created_at: at,
              accepted_at: null,
              retired_at: null,
            })} RETURNING id
          `;
          return row?.id ?? 0;
        }),
      );
      return yield* entryById(id);
    },
    Effect.catchTags({
      SqlError: io("Could not save the page."),
      SchemaError: io("Could not save the page."),
      ProjectOperationError: io("Could not read the project."),
    }),
  );

  const accept = Effect.fn("KnowledgeStore.accept")(
    function* ({ id, title, body }: KnowledgeAcceptInput) {
      yield* checkText(title, body);
      const at = yield* nowIso;
      const moved = yield* acceptRow({ id, title: title ?? null, body: body ?? null, at });
      // Gone, or no longer a draft: a second client is refused, not told the first one's result.
      if (Option.isNone(moved)) return yield* refused(id, "a draft is accepted");
      yield* installAfter(moved.value, "accepted");
      return moved.value;
    },
    Effect.catchTags({
      SqlError: io("Could not accept the page."),
      SchemaError: io("Could not accept the page."),
    }),
  );

  const retire = Effect.fn("KnowledgeStore.retire")(
    function* ({ id }: KnowledgeIdInput) {
      const at = yield* nowIso;
      const moved = yield* retireRow({ id, from: "accepted", at });
      if (Option.isNone(moved)) return yield* refused(id, "an accepted page is retired");
      yield* installAfter(moved.value, "retired");
      return moved.value;
    },
    Effect.catchTags({
      SqlError: io("Could not retire the page."),
      SchemaError: io("Could not retire the page."),
    }),
  );

  const discard = Effect.fn("KnowledgeStore.discard")(
    function* ({ id }: KnowledgeIdInput) {
      const at = yield* nowIso;
      const moved = yield* retireRow({ id, from: "draft", at });
      if (Option.isNone(moved)) return yield* refused(id, "a draft is discarded");
      return moved.value;
    },
    Effect.catchTags({
      SqlError: io("Could not discard the draft."),
      SchemaError: io("Could not discard the draft."),
    }),
  );

  return KnowledgeStore.of({
    list,
    propose,
    accept,
    retire,
    discard,
    install,
    verify,
    drift,
    outdated,
    catchUp,
  });
});

export const layer = Layer.effect(KnowledgeStore, make);
