import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type CavemanAgent,
  type CavemanAgentRoute,
  type CavemanRoute,
  type CavemanStatus,
  type ServerProvider,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeNet from "node:net";

import * as ServerConfig from "../../config.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as CavemanService from "./CavemanService.ts";
import * as Cli from "./Cli.ts";

const windowsHost = HostProcess.Platform.defaultValue() === "win32";

const provider = (instanceId: string, driver: string): ServerProvider => ({
  driver: ProviderDriverKind.make(driver),
  instanceId: ProviderInstanceId.make(instanceId),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  checkedAt: "2026-10-12T00:00:00.000Z",
  auth: { status: "authenticated" },
  models: [],
  skills: [],
  slashCommands: [],
});
const providers = [
  provider("claudeAgent", "claudeAgent"),
  provider("claude_work", "claudeAgent"),
  provider("codex", "codex"),
  provider("codex_work", "codex"),
  provider("codex_managed", "codex"),
  provider("cursor", "cursor"),
  provider("grok", "grok"),
  provider("antigravity", "antigravity"),
  provider("opencode", "opencode"),
  // A driver caveman has no name for is left out of the status.
  provider("pi", "pi"),
];

const gateway = "https://gateway.example.com";
const routedSettings = JSON.stringify({ env: { ANTHROPIC_BASE_URL: `${gateway}/w/claude` } });
const routedConfig = 'model_provider = "caveman"\n[model_providers.caveman]\n';

interface Stub {
  readonly root: string;
  readonly calls: string;
}

/**
 * A `caveman` that records `argv|CLAUDE_CONFIG_DIR|CODEX_HOME` per call and changes the config
 * files the way the real one does, so a status read after it sees the change.
 */
const recordingStub = ({ calls }: Stub) => `#!/bin/sh
printf '%s|%s|%s\\n' "$*" "\${CLAUDE_CONFIG_DIR-unset}" "\${CODEX_HOME-unset}" >> '${calls}'
claude_dir="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
codex_dir="\${CODEX_HOME:-$HOME/.codex}"
case "$*" in
  --version) printf '{"version":"9.9.9"}\\n' ;;
  "enable claude") mkdir -p "$claude_dir"; printf '%s' '${routedSettings}' > "$claude_dir/settings.json" ;;
  "disable claude") rm -f "$claude_dir/settings.json" ;;
  "enable codex") mkdir -p "$codex_dir"; printf '${routedConfig.replaceAll("\n", "\\n")}' > "$codex_dir/config.toml" ;;
  *) echo "unexpected $*" >&2; exit 64 ;;
esac
`;

/** The service over a temp `PATH`, home and gateway; `stub` is the `caveman` script, when there is one. */
const start = Effect.fn("test.start")(function* (
  options: { readonly stub?: (stub: Stub) => string; readonly gateway?: string } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-caveman-test-" });
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const calls = path.join(root, "calls.txt");
  yield* fs.makeDirectory(bin);
  yield* fs.makeDirectory(home);
  const env = {
    PATH: options.stub ? `${bin}:/usr/bin:/bin` : bin,
    HOME: home,
    CAVE_GATEWAY_URL: options.gateway ?? gateway,
  };
  const install = (stub: (stub: Stub) => string) =>
    fs.writeFileString(path.join(bin, "caveman"), stub({ root, calls }), { mode: 0o755 });
  if (options.stub) yield* install(options.stub);

  const dirs = {
    home,
    claudeWork: path.join(root, "claude-work"),
    codexWork: path.join(root, "codex-work"),
  };
  const services = yield* Layer.build(
    CavemanService.layer.pipe(
      Layer.provideMerge(
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed(providers) }),
      ),
      Layer.provideMerge(
        ServerSettings.layerTest({
          providerInstances: {
            [ProviderInstanceId.make("claude_work")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              config: { homePath: dirs.claudeWork },
            },
            [ProviderInstanceId.make("codex_work")]: {
              driver: ProviderDriverKind.make("codex"),
              config: { homePath: dirs.codexWork },
            },
            [ProviderInstanceId.make("codex_managed")]: {
              driver: ProviderDriverKind.make("codex"),
              config: { setupMode: "managed" },
            },
          },
        }),
      ),
      Layer.provideMerge(ServerConfig.layerTest(root, { prefix: "t3-caveman-config-" })),
    ),
  );
  const caveman = Context.get(services, CavemanService.CavemanService);
  const within = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.provideService(HostProcess.Environment, env),
      Effect.provideService(HostProcess.HomeDirectory, home),
    );
  return {
    root,
    dirs,
    install,
    write: (file: string, text: string) =>
      fs
        .makeDirectory(path.dirname(file), { recursive: true })
        .pipe(Effect.andThen(fs.writeFileString(file, text))),
    status: within(caveman.status),
    setRoute: (instanceId: string, enabled: boolean) =>
      within(caveman.setRoute({ instanceId: ProviderInstanceId.make(instanceId), enabled })),
    /** What `caveman` recorded, in order. */
    recorded: fs.readFileString(calls).pipe(
      Effect.orElseSucceed(() => ""),
      Effect.map((text) => text.split("\n").filter((line) => line !== "")),
    ),
  };
});

const row = (
  instanceId: string,
  agent: CavemanAgent,
  route: CavemanRoute,
  detail: string | null,
  configPath: string | null,
): CavemanAgentRoute => ({
  instanceId: ProviderInstanceId.make(instanceId),
  agent,
  route,
  detail,
  configPath,
});
const agent = (status: CavemanStatus, instanceId: string) =>
  status.agents.find((candidate) => candidate.instanceId === instanceId);
const withoutVersionProbes = (lines: ReadonlyArray<string>) =>
  lines.filter((line) => !line.startsWith("--version|"));

/** Each test gets a temp directory and the Node file system, process and path services. */
const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
  >,
) => effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe.skipIf(windowsHost)("CavemanService", () => {
  it.effect(
    "without caveman on PATH it is not installed and switching refuses with the install command",
    () =>
      run(
        Effect.gen(function* () {
          const h = yield* start();
          const status = yield* h.status;
          assert.isFalse(status.installed);
          assert.isNull(status.version);
          const error = yield* Effect.flip(h.setRoute("claude_work", true));
          assert.strictEqual(error.code, "not_installed");
          assert.strictEqual(
            error.message,
            "caveman is not installed. Run: npm install -g @caveman-ai/cli && caveman setup --install",
          );
          assert.strictEqual(error.message, Cli.INSTALL_REFUSAL);
        }),
      ),
  );

  it.effect("reads the version once a minute, but a missing binary is looked for every time", () =>
    run(
      Effect.gen(function* () {
        const h = yield* start();
        assert.isFalse((yield* h.status).installed);
        yield* h.install(recordingStub);
        const first = yield* h.status;
        assert.isTrue(first.installed);
        assert.strictEqual(first.version, "9.9.9");

        yield* h.status;
        assert.deepStrictEqual(yield* h.recorded, ["--version|unset|unset"]);
        yield* TestClock.adjust("61 seconds");
        yield* h.status;
        assert.deepStrictEqual(yield* h.recorded, [
          "--version|unset|unset",
          "--version|unset|unset",
        ]);
      }),
    ),
  );

  it.effect("reads each instance's own config directory, not only ~/.claude and ~/.codex", () =>
    run(
      Effect.gen(function* () {
        const h = yield* start({ stub: recordingStub });
        yield* h.write(`${h.dirs.home}/.claude/settings.json`, routedSettings);
        yield* h.write(
          `${h.dirs.claudeWork}/settings.json`,
          JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://elsewhere.example.com" } }),
        );
        yield* h.write(`${h.dirs.codexWork}/config.toml`, routedConfig);
        const status = yield* h.status;

        const unsupported = (instanceId: string, agent: CavemanAgent, detail: string) =>
          row(instanceId, agent, "unsupported", detail, null);
        const notRouted = "caveman does not route this provider";
        assert.deepStrictEqual(status.agents, [
          row("claudeAgent", "claude", "routed", null, `${h.dirs.home}/.claude/settings.json`),
          row(
            "claude_work",
            "claude",
            "other",
            "https://elsewhere.example.com",
            `${h.dirs.claudeWork}/settings.json`,
          ),
          row("codex", "codex", "direct", null, `${h.dirs.home}/.codex/config.toml`),
          row("codex_work", "codex", "routed", null, `${h.dirs.codexWork}/config.toml`),
          unsupported("codex_managed", "codex", "managed sign-in sets its own model provider"),
          unsupported("cursor", "cursor", notRouted),
          unsupported("grok", "grok", notRouted),
          unsupported("antigravity", "antigravity", notRouted),
          unsupported("opencode", "opencode", "not wired yet"),
        ]);
        assert.deepStrictEqual(status.proxy, { origin: gateway, listening: null });
      }),
    ),
  );

  it.effect("enables and disables Claude once each, in the instance's own config directory", () =>
    run(
      Effect.gen(function* () {
        const h = yield* start({ stub: recordingStub });
        assert.strictEqual(agent(yield* h.status, "claude_work")?.route, "direct");

        const enabled = yield* h.setRoute("claude_work", true);
        assert.strictEqual(agent(enabled, "claude_work")?.route, "routed");
        assert.deepStrictEqual((yield* h.recorded).slice(1), [
          `enable claude|${h.dirs.claudeWork}|unset`,
        ]);

        const disabled = yield* h.setRoute("claude_work", false);
        assert.strictEqual(agent(disabled, "claude_work")?.route, "direct");
        assert.deepStrictEqual((yield* h.recorded).slice(1), [
          `enable claude|${h.dirs.claudeWork}|unset`,
          `disable claude|${h.dirs.claudeWork}|unset`,
        ]);
      }),
    ),
  );

  it.effect("an instance without a custom home leaves CLAUDE_CONFIG_DIR and CODEX_HOME alone", () =>
    run(
      Effect.gen(function* () {
        const h = yield* start({ stub: recordingStub });
        assert.strictEqual(
          agent(yield* h.setRoute("claudeAgent", true), "claudeAgent")?.route,
          "routed",
        );
        assert.strictEqual(agent(yield* h.setRoute("codex", true), "codex")?.route, "routed");
        assert.deepStrictEqual(
          (yield* h.recorded).filter((line) => !line.startsWith("--")),
          ["enable claude|unset|unset", "enable codex|unset|unset"],
        );
      }),
    ),
  );

  it.effect("enables Codex with CODEX_HOME set to the instance's home", () =>
    run(
      Effect.gen(function* () {
        const h = yield* start({ stub: recordingStub });
        const status = yield* h.setRoute("codex_work", true);
        assert.strictEqual(agent(status, "codex_work")?.route, "routed");
        assert.deepStrictEqual(withoutVersionProbes(yield* h.recorded), [
          `enable codex|unset|${h.dirs.codexWork}`,
        ]);
      }),
    ),
  );

  it.effect("refuses an instance caveman does not route, without running anything", () =>
    run(
      Effect.gen(function* () {
        const h = yield* start({ stub: recordingStub });
        for (const instanceId of ["cursor", "opencode", "codex_managed", "pi", "nobody"]) {
          const error = yield* Effect.flip(h.setRoute(instanceId, true));
          assert.strictEqual(error.code, "not_routed");
          assert.strictEqual(
            error.message,
            `Agent "${instanceId}" is not routed by caveman from this server.`,
          );
        }
        assert.deepStrictEqual(yield* h.recorded, []);
      }),
    ),
  );

  it.effect("refuses with the last line of stderr when caveman exits non-zero", () =>
    run(
      Effect.gen(function* () {
        const h = yield* start({
          stub: () => "#!/bin/sh\necho 'starting' >&2\necho 'claude is not on PATH' >&2\nexit 3\n",
        });
        const error = yield* Effect.flip(h.setRoute("claude_work", true));
        assert.strictEqual(error.code, "failed");
        assert.strictEqual(error.message, "claude is not on PATH");
      }),
    ),
  );

  it.effect("refuses instead of hanging when caveman overruns its timeout", () =>
    run(
      Effect.gen(function* () {
        const started = (root: string) => `${root}/started`;
        const h = yield* start({
          stub: ({ root }) => `#!/bin/sh\necho started > '${started(root)}'\nexec sleep 120\n`,
        });
        const fs = yield* FileSystem.FileSystem;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        yield* spawner.exitCode(ChildProcess.make("mkfifo", [started(h.root)]));
        const refused = yield* Effect.forkChild(Effect.flip(h.setRoute("claude_work", true)));
        // Reading the pipe returns once the stub runs, which is after the timeout is armed.
        yield* fs.readFileString(started(h.root));
        yield* TestClock.adjust("60 seconds");
        const error = yield* Fiber.join(refused);
        assert.strictEqual(error.code, "failed");
        assert.strictEqual(error.message, "caveman did not finish within 60 seconds.");
      }),
    ),
  );

  it.effect("reports whether a local proxy is listening", () =>
    run(
      Effect.gen(function* () {
        const server = NodeNet.createServer();
        yield* Effect.callback<void>((resume) => {
          server.listen(0, "127.0.0.1", () => resume(Effect.void));
        });
        const { port } = server.address() as NodeNet.AddressInfo;
        const h = yield* start({ gateway: `http://127.0.0.1:${port}/` });
        assert.deepStrictEqual((yield* h.status).proxy, {
          origin: `http://127.0.0.1:${port}`,
          listening: true,
        });
        yield* Effect.callback<void>((resume) => {
          server.close(() => resume(Effect.void));
        });
        assert.isFalse((yield* h.status).proxy.listening);
      }),
    ),
  );
});
