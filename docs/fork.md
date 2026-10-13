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
  `/plugins/<id>`; every plugin is listed, with an on/off switch, at `/plugins`. That page shows
  the primary environment, or the one its `machine` search names; settings panels read
  `usePluginEnvironmentId` so they follow it.

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

A sweep that finds something waiting on a person raises a flag with `Attention.raise` and clears it
with `Attention.clear` once the cause is gone. Flags live in the host's `attention` table in that
same file, so any plugin can raise one without depending on the plugin that shows them.

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
| `packages/client-runtime/package.json`                       | the `./plugins/rpc` and `./plugins/kanban` entries at the end of `exports`                                                                                             |
| `apps/mobile/src/Stack.tsx`                                  | `SettingsKanbanBoard` at the end of `SettingsContentStack`'s screens, plus its import                                                                                  |
| `apps/mobile/.../SettingsProjectOverviewRouteScreen.tsx`     | in `features/settings/`: `<KanbanBoardEntries />` between the Project and Checkouts sections, plus its import                                                          |
| `apps/web/src/routes/_chat.board.tsx`                        | the kanban board's own route; a new plugin screen uses `/plugins/<id>` through the registry instead                                                                    |
| `apps/web/src/components/sidebar/mainAppLocation.ts`         | `/board` and the `/plugins` paths in `isSidebarUtilityPage`                                                                                                            |
| `apps/web/src/components/sidebar/SidebarChrome.tsx`          | the board's `SidebarUtilityItem`, gated on `kanbanSupportedAtom`, and `<PluginSidebarEntries />` after the Usage entry, plus imports; `SidebarUtilityItem` is exported |
| `apps/web/src/components/CommandPalette.tsx`                 | the board's `actionItems.push` block, gated the same way, plus imports                                                                                                 |
| `third-party-licenses.config.json`                           | the `Caveman reply rules` and `Ponytail ladder` entries at the end of `customNotices`, so the adapted policy text is credited in the app's license list                |

## Plugin services and the type system

A plugin's layer is merged into the server only when the plugin is active, so the server's layer
chain never types its services as present. Anything outside the plugin's own layer that needs one,
such as a plugin method's handler (the host dispatches to it whether or not the plugin runs) or an
MCP handler layer, reads it with `Effect.serviceOption` and fails with the plugin's own "inactive"
error when it is absent. Declaring it as a `Tool` dependency or yielding the tag directly makes the
whole server require it and fails to typecheck. See
[`plugins/kanban/handlers.ts`](../apps/server/src/plugins/kanban/handlers.ts).

A sweep's `run` executes in the supervisor's tick with every active plugin's services, so it can
read a sibling plugin's service with `Effect.serviceOption` without either plugin listing the other
in `dependsOn`. A plugin's layer still cannot see its siblings while it builds.

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
  Its own database, `plugins/kanban.sqlite`, holds the emergency stop (`StopGate`, which a sweep
  that starts a thread must ask first; no launcher calls it yet). The `writers` sweep raises an
  attention flag when two agents write one project. `kanban.attention.list` feeds the strip above
  the board from the project's open host flags, its threads' pending questions and permission
  requests, and, while routing runs, its routing mismatches. Mobile shows the board as a read-only
  list grouped by column, from the Board row on a project's overview; it and the web board share
  the board and active-plugin atoms in `packages/client-runtime/src/plugins/kanban.ts`. Server:
  `apps/server/src/plugins/kanban/`. Contracts: `packages/contracts/src/plugins/kanban.ts`. Web:
  `apps/web/src/plugins/kanban/`. Mobile: `apps/mobile/src/features/kanban/`. User guide:
  [Kanban board](./user/kanban.md).
- **telemetry**: the fourteen efficiency measures of #1 over a project's window, from the
  `telemetry.measures` gateway method and the `telemetry_measures` MCP tool. Its reactor keeps
  runs, tool calls, threads and provider turn token usage from the event log in the plugin's own
  tables, and pure functions in `measures/` compute each measure from those rows; cost is priced
  with the rate table the Usage page saves. A measure whose input is not recorded, or comes from a
  plugin that is off or not built yet, answers `unavailable` with the reason. Migration 2 drops
  the reactor's cursor so the new tables fill from the first event; a request waits a few seconds
  for the reactor to catch up, and past that every measure answers `unavailable`. Where
  compaction before the upgrade kept a later thread event in place of a `thread.settled`, who
  settled is lost, and a thread settled by hand that way counts as an accepted outcome only if a
  pull request merged. With a `tier`, only the runs on that routing tier's provider instance and
  model count, and `context_efficiency` (output tokens per turn) answers only then; migration 3
  replays the log to record each run's instance. The `telemetry/budgets` sweep judges each budget,
  one measure for one tier, over the last seven whole UTC days per project, writes a
  `budget_events` row only when its state changes, and raises or clears a `budget_breach`
  attention flag. `telemetry.report` and the `telemetry_report` MCP tool fold a project's range
  into ten sections, from the thread records, the learning and review plugins and the host's
  attention flags, with the same report as one self-contained HTML page; at start the plugin gives
  each project with a default model a `Weekly report` thread and a scheduled task that posts that
  page there every Monday, and never touches a task that already exists. The template plugin: it
  uses every host seam once (database, reactor, sweep, gateway method, MCP tool, settings panel)
  and is the one to copy. Server: `apps/server/src/plugins/telemetry/`. Contracts:
  `packages/contracts/src/plugins/telemetry.ts` and `telemetryReport.ts`. Web:
  `apps/web/src/plugins/telemetry/`. User guide: [Weekly report](./user/weekly-report.md).
- **routing**: which model does which work. Three tiers, `cheap`, `standard` and `strong`, each map
  to a provider instance and a model, set for the environment and overridable per project, in the
  plugin's own database. A tier with nothing saved falls back to the built-in: one instance's model
  list, first model `strong`, last `cheap`. Agents read it with the `routing_tiers` MCP tool; the
  panel on the Plugins page reads and saves it through `routing.tiers.get` and `routing.tiers.set`.
  A launcher starts work through `TierSelectionService.launch` or `delegate`: they pick a tier from
  the caller's task class, one tier up per failed run of the same work, hand the launch that tier's
  model, and append a `routing_recommended` row to `routing_events`; with the plugin off the launch
  is unchanged. A reactor compares the thread's first run with its recommendation and appends one
  `routing_observed` row; `routing.adherence` and the `routing_adherence` MCP tool report the share
  that matched over a window, with each mismatch, and answer `unavailable` below five observed
  launches. Server: `apps/server/src/plugins/routing/`. Contracts:
  `packages/contracts/src/plugins/routing.ts`. Web: `apps/web/src/plugins/routing/`.
- **learning**: a record of corrections, visible instances of work going wrong, taken from
  events the server already emits: failed or interrupted provider turns, pull request wakes
  while changes are requested, and threads reopened after settlement. Agents read and add
  them over MCP. Two sweeps turn corrections with a declared failure mode into learning items, one
  per mode per project, routed by fixed rules on the mode to an owner kind, and hand each item
  over through one promotion record, at least once, keyed by the record's id so a promoter can
  drop a repeat; no promoter is registered yet, so records wait. A third sweep compares each
  project's telemetry measures over the last seven whole UTC days with the seven before, once a
  day, and opens or strengthens an `efficiency_regression:<measure>` item, with no owner kind, for
  each measure worse by its threshold in `regressions/thresholds.ts`; with telemetry off it does
  nothing. Server:
  `apps/server/src/plugins/learning/`. Contracts:
  `packages/contracts/src/plugins/learning.ts`. No screen yet.
- **policy**: reviewed working rules per project (`*` is the whole environment), versioned in the
  plugin's database and rendered as one marked block each, with `<state dir>/RULES.md` ahead of
  the body, into the instruction file each agent reads from the user's home. Verify re-reads the
  block. `policy.list` reads, with every version and each agent's file re-read but nothing marked
  verified; `policy.create`, `.accept`, `.install` and `.verify` are operate methods, and the
  `policy_list` MCP tool reads. A supervisor sweep installs and verifies accepted policies an
  agent lacks or holds under older rules, but only while no run is active on the project (any
  run, for `*`). The first start seeds `*` / `ponytail`, the six-question ladder, and `*` /
  `caveman`, the terse reply rules, each unless a policy of that key exists in any state; the
  review plugin refuses a `convention` summary that starts with `rung:` and names none of the six
  rung ids. Server: `apps/server/src/plugins/policy/`. Contracts:
  `packages/contracts/src/plugins/policy.ts`. Web: `apps/web/src/plugins/policy/`, the Policies
  screen at `/plugins/policy`. User guide:
  [Policies and reviews](./user/policies-and-reviews.md#policies).
- **review**: a reviewing agent's typed verdict on one checkpoint of another thread: `approve`, or
  `changes_requested` with one of six failure modes (`defect`, `incomplete`, `scope_drift`,
  `missing_verification`, `convention`, `unclear_spec`), so nothing reads reviewer prose to learn
  what went wrong. A `changes_requested` verdict records a `review_verdict` correction in the
  learning plugin, which is why the plugin depends on it. The two live in separate databases, so the
  correction is recorded first and the verdict row second; the verdict id is derived from the
  reviewer thread and checkpoint, so a retry finds the same correction. Agents give a verdict with
  the `review_verdict` MCP tool, from a thread only, and read them with `review_verdicts`;
  `review.verdicts` reads them over the gateway. A review request (`review_request`,
  `review.request`) names the thread's latest ready root checkpoint and a verdict on it answers
  the request; once the thread's latest is another checkpoint, the `review/invalidation` sweep marks
  the request stale for good, invalidates the verdicts on its checkpoint, opens a request at the
  latest, and keeps a `stale_review` attention flag until that one is answered. `ReviewGate.check`
  is the completion gate a ticket asks before it finishes; nothing calls it yet. Server:
  `apps/server/src/plugins/review/`. Contracts: `packages/contracts/src/plugins/review.ts`. No
  screen yet. User guide: [Policies and reviews](./user/policies-and-reviews.md#reviews).
- **caveman**: whether each provider instance's model traffic goes through caveman's loopback
  proxy, `routed`, `direct`, `other` or `unsupported`, read from the Claude `settings.json` and
  Codex `config.toml` the instance starts with, and a switch that runs caveman's own `enable` and
  `disable` commands. Its database keeps the newest eight `caveman learn` reports, which the
  `caveman/learn` sweep imports from `$CAVEMAN_HOME`; the panel's Refresh runs `caveman learn scan`,
  which writes caveman's own report, and the plugin writes no other file. Agents read it with the
  `caveman_status` and `caveman_learn_findings` MCP tools, the latter never with a sink's evidence;
  the panel on the Plugins page uses `caveman.status`, `caveman.setRoute`, `caveman.learnPlan` and
  `caveman.learnRefresh`. Server: `apps/server/src/plugins/caveman/`. Contracts:
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
