# Fork notes

This fork adds plugins on top of upstream `pingdotgg/t3code`. Plugins live in their own
directories and never edit an upstream file. Upstream is merged nightly by
`.github/workflows/sync-upstream.yml`; a conflict opens a pull request from `sync/upstream`.

## Where plugin code lives

- `apps/server/src/plugins/` holds the host (`PluginHost.ts`, `Plugin.ts`, `registry.ts`) and one
  directory per plugin.
- `packages/contracts/src/plugins/` holds each plugin's schemas and method definitions.
- `apps/web/src/plugins/` holds each plugin's screens.
  A plugin with a screen is registered in `apps/web/src/plugins/registry.ts` and reached at
  `/plugins/<id>`; every plugin is listed, with an on/off switch, at `/plugins`.

Enabled state is `plugins.json` under the server state directory. A missing entry means enabled.
Changes apply on the next server start.

A plugin that declares `migrations` gets its own SQLite file, `plugins/<id>.sqlite` under the state
directory, opened and migrated before the plugin starts; its `layer` and `mcp` see that file as
`SqlClient`, never the core database. A failed migration keeps the plugin, and anything that depends
on it, off for that start and shows as `startError` in `plugins.list`.

A plugin reacts to committed orchestration events through `PluginReactor.start` in
`apps/server/src/plugins/PluginReactor.ts`, which keeps its cursor and failed events in the plugin's
own database, so a restart replays only what the plugin missed. It reads `EventSinkV2.stream`, not
`Orchestrator.streamDomainEvents`, because only the former carries a sequence to resume from.

A plugin registers sweeps with `PluginSupervisor.register` from its layer. The host runs them on
the `supervisor.json` interval, in registry order, and records each tick in `plugins/_host.sqlite`;
`supervisor.status` reads the latest.

## Upstream seams

These are the only lines upstream files carry for the plugin system. A merge conflict in one of
them is resolved by keeping the line.

| File                                                         | Line                                                                                                                                                                   |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/rpc.ts`                              | `...PLUGIN_RPCS,` inside `RpcGroup.make(...)`, plus its import                                                                                                         |
| `packages/contracts/src/clientRpcPermissions.ts`             | `...PLUGIN_GUARDED_RPC_SCOPES,` inside `CLIENT_GUARDED_RPC_SCOPES`, plus its import                                                                                    |
| `packages/contracts/src/index.ts`                            | `export * from "./plugins/host.ts";`                                                                                                                                   |
| `apps/server/src/ws.ts`                                      | `...PluginHost.handlers,` inside `ServerWsRpcGroup.of({...})`, plus its import                                                                                         |
| `apps/server/src/server.ts`                                  | `Layer.provideMerge(PluginHost.layerAll),` before `layerRuntimeServices`, plus its import                                                                              |
| `apps/server/src/mcp/McpHttpServer.ts`                       | `PluginHost.layerMcp(toolkitRegistration),` inside the exported `layer`, plus its import                                                                               |
| `apps/server/src/observability/RpcInstrumentation.ts`        | `...PLUGIN_RPC_SUBSYSTEMS,` in the subsystem map, plus the import                                                                                                      |
| `apps/server/src/auth/RpcAuthorization.ts`                   | `...PLUGIN_RPC_SCOPES,` inside `RPC_REQUIRED_SCOPES`, plus its import                                                                                                  |
| `apps/server/src/mcp/toolkits/worktree/registration.test.ts` | the `PluginHost` and `PluginSupervisor` mocks in the service list, plus their imports                                                                                  |
| `packages/client-runtime/src/rpc/client.ts`                  | `\| PluginSubscriptionRpcTag` in `EnvironmentSubscriptionRpcTag`, plus its import                                                                                      |
| `packages/client-runtime/package.json`                       | the `./plugins/rpc` entry at the end of `exports`                                                                                                                      |
| `apps/web/src/routes/_chat.board.tsx`                        | the kanban board's own route; a new plugin screen uses `/plugins/<id>` through the registry instead                                                                    |
| `apps/web/src/components/sidebar/mainAppLocation.ts`         | `/board` and the `/plugins` paths in `isSidebarUtilityPage`                                                                                                            |
| `apps/web/src/components/sidebar/SidebarChrome.tsx`          | the board's `SidebarUtilityItem`, gated on `kanbanSupportedAtom`, and `<PluginSidebarEntries />` after the Usage entry, plus imports; `SidebarUtilityItem` is exported |
| `apps/web/src/components/CommandPalette.tsx`                 | the board's `actionItems.push` block, gated the same way, plus imports                                                                                                 |

## Plugin services and the type system

A plugin's layer is merged into the server only when the plugin is active, so the server's layer
chain never types its services as present. Anything outside the plugin's own layer that needs one,
such as a plugin method's handler (the host dispatches to it whether or not the plugin runs) or an
MCP handler layer, reads it with `Effect.serviceOption` and fails with the plugin's own "inactive"
error when it is absent. Declaring it as a `Tool` dependency or yielding the tag directly makes the
whole server require it and fails to typecheck. See
[`plugins/kanban/handlers.ts`](../apps/server/src/plugins/kanban/handlers.ts).

Plugin methods go through three gateway RPCs, `plugins.read`, `plugins.operate` and
`plugins.settingsWrite`, one per scope, because the WebSocket RPC group sits at TypeScript's
instantiation limit: a couple more tags and `ServerWsRpcGroup.toLayer` fails with TS2589. A plugin
adds a method only in its own contract file (`definePluginMethods`) and its dispatch table
(`PluginRpc.defineHandlers`); clients call it with `createPluginRpcCommand` or
`createPluginRpcQueryAtomFamily` from `@t3tools/client-runtime/plugins/rpc`. Only stream RPCs keep
a tag of their own.

A plugin never imports `McpHttpServer`: that module imports the host, and the cycle leaves one of
them half-evaluated. The host hands `toolkitRegistration` to `ServerPlugin.mcp` instead.

## Plugins

- **kanban**: a board per project. Issues and decisions are files under
  `<T3 home>/wiki/<project-slug>/`; the folder is changeable per project from the board.
  Server: `apps/server/src/plugins/kanban/`. Contracts: `packages/contracts/src/plugins/kanban.ts`.
  Web: `apps/web/src/plugins/kanban/`. User guide: [Kanban board](./user/kanban.md).
- **telemetry**: token usage per provider turn, from `provider-turn.updated`. The template plugin:
  it uses every host seam once (database, reactor, sweep, gateway method, MCP tool, settings
  panel) and is the one to copy. Server: `apps/server/src/plugins/telemetry/`. Contracts:
  `packages/contracts/src/plugins/telemetry.ts`. Web: `apps/web/src/plugins/telemetry/`.
- **routing**: which model does which work. Three tiers, `cheap`, `standard` and `strong`, each map
  to a provider instance and a model, set for the environment and overridable per project, in the
  plugin's own database. A tier with nothing saved falls back to the built-in: one instance's model
  list, first model `strong`, last `cheap`. Agents read it with the `routing_tiers` MCP tool; the
  panel on the Plugins page reads and saves it through `routing.tiers.get` and `routing.tiers.set`.
  Server: `apps/server/src/plugins/routing/`. Contracts: `packages/contracts/src/plugins/routing.ts`.
  Web: `apps/web/src/plugins/routing/`.
- **learning**: a record of corrections, visible instances of work going wrong, taken from
  events the server already emits: failed or interrupted provider turns, pull request wakes
  while changes are requested, and threads reopened after settlement. Agents read and add
  them over MCP. Server: `apps/server/src/plugins/learning/`. Contracts:
  `packages/contracts/src/plugins/learning.ts`. No screen yet.
- **review**: a reviewing agent's typed verdict on one checkpoint of another thread: `approve`, or
  `changes_requested` with one of six failure modes (`defect`, `incomplete`, `scope_drift`,
  `missing_verification`, `convention`, `unclear_spec`), so nothing reads reviewer prose to learn
  what went wrong. A `changes_requested` verdict records a `review_verdict` correction in the
  learning plugin, which is why the plugin depends on it. The two live in separate databases, so the
  correction is recorded first and the verdict row second; the verdict id is derived from the
  reviewer thread and checkpoint, so a retry finds the same correction. Agents give a verdict with
  the `review_verdict` MCP tool, from a thread only, and read them with `review_verdicts`;
  `review.verdicts` reads them over the gateway. Server: `apps/server/src/plugins/review/`.
  Contracts: `packages/contracts/src/plugins/review.ts`. No screen yet.
- **caveman**: whether each provider instance's model traffic goes through caveman's loopback
  proxy, `routed`, `direct`, `other` or `unsupported`, read from the Claude `settings.json` and
  Codex `config.toml` the instance starts with, and a switch that runs caveman's own `enable` and
  `disable` commands. The plugin writes no file and keeps no database. Agents read it with the
  `caveman_status` MCP tool; the panel on the Plugins page uses `caveman.status` and
  `caveman.setRoute`. Server: `apps/server/src/plugins/caveman/`. Contracts:
  `packages/contracts/src/plugins/caveman.ts`. Web: `apps/web/src/plugins/caveman/`.

`apps/web/src/routeTree.gen.ts` is generated and committed. A conflict there is resolved by running
the web dev server or build once, which regenerates it.

## Keeping up with upstream

`.github/workflows/sync-upstream.yml` merges `pingdotgg/t3code` main at 04:23 UTC and can be run by
hand from the Actions tab. A clean merge is pushed straight to `main`. A conflict pushes upstream's
head to `sync/upstream`, opens a pull request into `main`, and posts one `@copilot` comment on it
asking the Copilot cloud agent to resolve the conflicts on that branch. The branch is never
force-pushed, so a resolution someone pushes there survives the next night. Merging the pull
request, or landing upstream on `main` any other way, makes the next run close it.

The handoff needs two things: a repository secret `SYNC_TOKEN` holding a fine-grained token with
Contents and Pull requests set to read and write, and the Copilot cloud agent enabled for the
account that owns the token (profile menu, Copilot settings, Cloud agent). Without the secret the
job still opens the pull request and waits for a person.

Resolving a conflict by hand: keep the seam lines above, take upstream's side everywhere else, and
regenerate `apps/web/src/routeTree.gen.ts` by running the web build.

A sync can bring in new upstream workflows. Most of them are scheduled on Blacksmith runners this
fork does not have, so their runs queue forever. After a sync, check the Actions tab and disable
anything new. Only Fork CI, Sync upstream and Fork nightly release stay active.

## Nightly builds

`.github/workflows/release-fork.yml` runs at 05:41 UTC on days `main` moved and can be run by hand.
It builds the Windows x64 and Linux x64 desktop apps and CLI archives, unsigned, through upstream's
reusable build job on GitHub-hosted runners, and publishes them as a prerelease tagged
`v<version>-nightly.<date>.<n>`. There is no macOS build; signing it needs an Apple developer
account.

Install the first copy by hand from the Releases page. Windows shows a SmartScreen prompt once
because the build is unsigned: More info, then Run anyway. From then on the app updates itself from
this fork's releases on the nightly channel. An app installed from upstream keeps updating from
upstream, so it has to be replaced once. The `t3` CLI from one of these archives updates from this
fork as well.
