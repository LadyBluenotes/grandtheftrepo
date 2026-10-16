import {
  CavemanError,
  ClaudeSettings,
  CodexSettings,
  type CavemanAgent,
  type CavemanAgentRoute,
  type CavemanLearnFindings,
  type CavemanLearnFindingsInput,
  type CavemanLearnPlanInput,
  type CavemanLearnPlanResult,
  type CavemanSetRouteInput,
  type CavemanStatus,
} from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import { ChildProcessSpawner } from "effect/process";
import * as NodeNet from "node:net";

import * as ServerConfig from "../../config.ts";
import { makeClaudeEnvironment, resolveClaudeHomePath } from "../../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../../provider/Drivers/CodexHomeLayout.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as Cli from "./Cli.ts";
import * as LearnImport from "./learn/import.ts";
import * as LearnScan from "./learn/scan.ts";
import { claudeRoute, codexRoute, proxyOrigin } from "./RouteStatus.ts";

export class CavemanService extends Context.Service<
  CavemanService,
  {
    /** Whether caveman is installed, where its proxy listens, and each instance's route. */
    readonly status: Effect.Effect<CavemanStatus, CavemanError>;
    /** Runs `caveman enable` or `disable` for the instance, then returns `status`. */
    readonly setRoute: (input: CavemanSetRouteInput) => Effect.Effect<CavemanStatus, CavemanError>;
    /** The newest imported `caveman learn` plan with its sinks and their evidence, every sink unless `limit` says otherwise, and the scan's state. */
    readonly learnPlan: (
      input: CavemanLearnPlanInput,
    ) => Effect.Effect<CavemanLearnPlanResult, CavemanError>;
    /**
     * Starts `caveman learn scan` from the home directory, pointed at the first Claude and Codex
     * instances' homes when they have a custom `homePath`. Refuses while caveman is missing or a
     * scan runs.
     */
    readonly learnRefresh: Effect.Effect<{ readonly started: true }, CavemanError>;
    /** The newest plan's header and top findings, 10 unless `limit` says otherwise, without evidence. */
    readonly learnFindings: (
      input: CavemanLearnFindingsInput,
    ) => Effect.Effect<CavemanLearnFindings, CavemanError>;
  }
>()("t3/plugins/caveman/CavemanService") {}

/**
 * For code outside the plugin's layer, such as a WebSocket handler: the service when the plugin
 * runs, else the plugin's own error. Plugin services are typed as absent from the server chain.
 */
export const fromOption = Option.match({
  onNone: () => new CavemanError({ code: "inactive", message: 'Plugin "caveman" is not running.' }),
  onSome: Effect.succeed<CavemanService["Service"]>,
});

/** The agent caveman knows each driver as. A driver missing here is left out of the status. */
const AGENT_OF_DRIVER: Readonly<Record<string, CavemanAgent>> = {
  claudeAgent: "claude",
  codex: "codex",
  cursor: "cursor",
  grok: "grok",
  opencode: "opencode",
  antigravity: "antigravity",
};

const decodeClaude = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodex = Schema.decodeUnknownOption(CodexSettings);
const decodeVersion = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
);

const DEFAULT_FINDINGS = 10;
const VERSION_TIMEOUT = "10 seconds";
const VERSION_TTL = "60 seconds";
const ROUTE_TIMEOUT_SECONDS = 60;
const CONNECT_TIMEOUT = "2 seconds";

/** One TCP connect; anything but a prompt connection is "not listening". */
const connects = (host: string, port: number) =>
  Effect.callback<boolean>((resume) => {
    const socket = NodeNet.connect({ host, port });
    // The cleanup below runs only on interruption, so a settled connect closes its own socket.
    socket.once("connect", () => {
      socket.destroy();
      resume(Effect.succeed(true));
    });
    socket.once("error", () => {
      socket.destroy();
      resume(Effect.succeed(false));
    });
    return Effect.sync(() => socket.destroy());
  }).pipe(Effect.timeoutOption(CONNECT_TIMEOUT), Effect.map(Option.getOrElse(() => false)));

/** Null when the origin is not on this machine, where one connect would prove nothing. */
export const listening = (origin: string) => {
  if (!URL.canParse(origin)) return Effect.succeed(null);
  const url = new URL(origin);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // `127.example.com` is a DNS name, so only an IPv4 literal counts as 127.0.0.0/8.
  const loopback =
    host === "localhost" || host === "::1" || (NodeNet.isIPv4(host) && host.startsWith("127."));
  if (!loopback) return Effect.succeed(null);
  return connects(host, Number(url.port) || (url.protocol === "https:" ? 443 : 80));
};

/** An instance's route, with the environment `caveman enable|disable` runs in when it can switch it. */
interface Resolved {
  readonly row: CavemanAgentRoute;
  readonly environment?: NodeJS.ProcessEnv;
  /** The variable that points a learn scan at the instance's home; only for a custom `homePath`. */
  readonly scanHome?: NodeJS.ProcessEnv;
}

const make = Effect.gen(function* () {
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const settings = yield* ServerSettings.ServerSettingsService;
  const { cwd } = yield* ServerConfig.ServerConfig;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const scanner = yield* LearnScan.make;

  const run = (input: Parameters<typeof Cli.run>[0]) =>
    Cli.run(input).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

  /** A file that is absent or unreadable sets nothing, so it reads as no route. */
  const readText = (filePath: string) =>
    fs.readFileString(filePath).pipe(Effect.option, Effect.map(Option.getOrNull));

  const instances = Effect.gen(function* () {
    const hostEnv = yield* HostProcess.Environment;
    const origin = proxyOrigin(hostEnv.CAVE_GATEWAY_URL);
    const current = yield* settings.getSettings.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not read the server settings.", { cause }).pipe(
          Effect.andThen(
            Effect.fail(
              new CavemanError({
                code: "failed",
                message: "Could not read the server settings.",
              }),
            ),
          ),
        ),
      ),
    );
    const resolved: Array<Resolved> = [];
    for (const provider of yield* providers.getProviders) {
      const agent = AGENT_OF_DRIVER[provider.driver];
      if (agent === undefined) continue;
      const { instanceId } = provider;
      const unsupported = (detail: string) =>
        resolved.push({
          row: { instanceId, agent, route: "unsupported", detail, configPath: null },
        });
      const saved = current.providerInstances[instanceId];
      // The environment the provider itself starts with, so the answer matches where it reads.
      const processEnv = yield* mergeProviderInstanceEnvironment(saved?.environment, hostEnv);

      if (agent === "claude") {
        const config = decodeClaude(saved?.config ?? {});
        if (Option.isNone(config)) continue;
        const home = yield* resolveClaudeHomePath(config.value, processEnv);
        const configPath = path.join(home, "settings.json");
        resolved.push({
          row: {
            instanceId,
            agent,
            ...claudeRoute(yield* readText(configPath), origin),
            configPath,
          },
          environment: yield* makeClaudeEnvironment(config.value, processEnv),
          ...(config.value.homePath.trim() === "" ? {} : { scanHome: { CLAUDE_CONFIG_DIR: home } }),
        });
      } else if (agent === "codex") {
        const config = decodeCodex(saved?.config ?? {});
        if (Option.isNone(config)) continue;
        if (config.value.setupMode === "managed") {
          unsupported("managed sign-in sets its own model provider");
          continue;
        }
        // As codex starts: with no home of its own, an instance's CODEX_HOME names the home.
        const environmentHome = processEnv.CODEX_HOME?.trim();
        const codexConfig =
          config.value.homePath.trim() === "" &&
          config.value.shadowHomePath.trim() === "" &&
          environmentHome
            ? { ...config.value, homePath: environmentHome }
            : config.value;
        const { sharedHomePath } = yield* resolveCodexHomeLayout(codexConfig);
        const configPath = path.join(sharedHomePath, "config.toml");
        resolved.push({
          row: {
            instanceId,
            agent,
            ...codexRoute(yield* readText(configPath)),
            configPath,
          },
          environment:
            codexConfig.homePath === ""
              ? processEnv
              : { ...processEnv, CODEX_HOME: sharedHomePath },
          ...(config.value.homePath.trim() === ""
            ? {}
            : { scanHome: { CODEX_HOME: sharedHomePath } }),
        });
      } else {
        unsupported(
          agent === "opencode" ? "not wired yet" : "caveman does not route this provider",
        );
      }
    }
    return resolved;
  }).pipe(Effect.provideService(Path.Path, path));

  // A missing binary is not cached, so installing caveman shows on the next read.
  const probe = yield* Effect.cachedWithTTL(
    Effect.gen(function* () {
      const outcome = yield* run({
        args: ["--version"],
        env: yield* HostProcess.Environment,
        cwd,
        timeout: VERSION_TIMEOUT,
      });
      return {
        installed: outcome._tag !== "Missing",
        version:
          outcome._tag === "Exited"
            ? Option.getOrNull(Option.map(decodeVersion(outcome.stdout), (json) => json.version))
            : null,
      };
    }),
    (exit) => (Exit.isSuccess(exit) && exit.value.installed ? VERSION_TTL : 0),
  );

  const status = Effect.fn("CavemanService.status")(function* () {
    const origin = proxyOrigin((yield* HostProcess.Environment).CAVE_GATEWAY_URL);
    const [{ installed, version }, listeningNow, resolved] = yield* Effect.all(
      [probe, listening(origin), instances],
      { concurrency: "unbounded" },
    );
    return {
      installed,
      version,
      proxy: { origin, listening: listeningNow },
      agents: resolved.map(({ row }) => row),
    } satisfies CavemanStatus;
  });

  const setRoute = Effect.fn("CavemanService.setRoute")(function* ({
    instanceId,
    enabled,
  }: CavemanSetRouteInput) {
    const target = (yield* instances).find(({ row }) => row.instanceId === instanceId);
    if (target?.environment === undefined) {
      return yield* new CavemanError({
        code: "not_routed",
        message: `Agent "${instanceId}" is not routed by caveman from this server.`,
      });
    }
    const outcome = yield* run({
      args: [enabled ? "enable" : "disable", target.row.agent],
      env: target.environment,
      cwd,
      timeout: `${ROUTE_TIMEOUT_SECONDS} seconds`,
    });
    if (outcome._tag === "Missing") {
      return yield* new CavemanError({ code: "not_installed", message: Cli.INSTALL_REFUSAL });
    }
    if (outcome._tag === "TimedOut") {
      return yield* new CavemanError({
        code: "failed",
        message: `caveman did not finish within ${ROUTE_TIMEOUT_SECONDS} seconds.`,
      });
    }
    if (outcome.code !== 0) {
      return yield* new CavemanError({ code: "failed", message: Cli.failureLine(outcome) });
    }
    return yield* status();
  });

  const unreadable = (cause: SqlError.SqlError) =>
    Effect.logWarning("caveman: database operation failed", { cause }).pipe(
      Effect.andThen(
        Effect.fail(
          new CavemanError({ code: "failed", message: "Could not read the caveman database." }),
        ),
      ),
    );

  const learnPlan = Effect.fn("CavemanService.learnPlan")(function* ({
    limit,
  }: CavemanLearnPlanInput) {
    const scan = yield* scanner.state;
    const newest = yield* LearnImport.latest(limit).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.catchTags({ SqlError: unreadable }),
    );
    return (
      newest === undefined ? { state: "none", scan } : { state: "ready", ...newest, scan }
    ) satisfies CavemanLearnPlanResult;
  });

  const learnRefresh = Effect.gen(function* () {
    if (!(yield* probe).installed) {
      return yield* new CavemanError({ code: "not_installed", message: Cli.INSTALL_REFUSAL });
    }
    // Only the first instance of each provider is scanned; caveman reads one home per provider.
    const resolved = yield* instances;
    const scanHome = (agent: CavemanAgent) =>
      resolved.find(({ row }) => row.agent === agent)?.scanHome;
    yield* scanner.start({
      env: { ...(yield* HostProcess.Environment), ...scanHome("claude"), ...scanHome("codex") },
      cwd: yield* HostProcess.HomeDirectory,
    });
    return { started: true } as const;
  }).pipe(Effect.withSpan("CavemanService.learnRefresh"));

  const learnFindings = Effect.fn("CavemanService.learnFindings")(function* ({
    limit,
  }: CavemanLearnFindingsInput) {
    return yield* LearnImport.findings(limit ?? DEFAULT_FINDINGS).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.catchTags({ SqlError: unreadable }),
    );
  });

  return CavemanService.of({
    status: status(),
    setRoute,
    learnPlan,
    learnRefresh,
    learnFindings,
  });
});

export const layer = Layer.effect(CavemanService, make);
