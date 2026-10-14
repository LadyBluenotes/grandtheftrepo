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
  `/plugins/<id>`; every plugin is listed, with an on/off switch, at `/plugins`. Both show the
  primary environment, or the one their `machine` search names; screens and settings panels read
  `usePluginEnvironmentId` so they follow it. A screen keeps its tab and open record in the URL
  (`tab` and `recordId`, through `usePluginScreenSearch`), and a screen with a project picker
  starts on the URL's `projectId`, so a link can open the thing it is about.

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
with `Attention.clear` once the cause is gone; `Attention.reconcile` does both for a plugin's flags
of one kind and skips a flag whose text is unchanged, so a tick that finds nothing new writes
nothing. Flags live in the host's `attention` table in that same file, so any plugin can raise one
without depending on the plugin that shows them. The strip above the kanban board and a project's
weekly report list a flag whose key is not a thread when the key ends in `:<projectId>`, has the
project id between colons, or starts with `policy:*:` (`plugins/attentionKeys.ts`); a flag keyed by
none of these is on no board and in no report. A flag's resume action leads to its thread, the
board, the Plugins page, or a plugin's screen on the row's project, if it has one, with an optional
tab and record (`AttentionResumeAction`); mobile has no plugin screens, so there a row with a plugin
target stays on the board.

A plugin says what it needs to do its work through `ServerPlugin.readiness`: checks, each `ready`,
`attention` or `off`, with one sentence and where a person fixes it. `PluginHost.readiness` runs
every active plugin's checks in the caller's fiber and gives a plugin that does not run one `off`
check naming its switch, the dependency that is off, or its start error; `plugins.readiness` and
the `plugins_readiness` MCP tool both answer with it, and the Plugins page shows it above the plugin
list. A plugin's checks come from one service built in its own layer and read with
`Readiness.fromService`, because the plugin's database is reachable only there: the caller's
`SqlClient` is the core one. Checks only read; none installs, starts a model or leaves loopback. See
[`plugins/Readiness.ts`](../apps/server/src/plugins/Readiness.ts).

## Upstream seams

These are the only lines upstream files carry for this fork. A merge conflict in one of them is
resolved by keeping the line.

| File                                                         | Line                                                                                                                                                                |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/rpc.ts`                              | `...PLUGIN_RPCS,` inside `RpcGroup.make(...)`, plus its import                                                                                                      |
| `packages/contracts/src/clientRpcPermissions.ts`             | `...PLUGIN_GUARDED_RPC_SCOPES,` inside `CLIENT_GUARDED_RPC_SCOPES`, plus its import                                                                                 |
| `packages/contracts/src/index.ts`                            | `export * from "./plugins/host.ts";`                                                                                                                                |
| `apps/server/src/ws.ts`                                      | `...PluginHost.handlers,` inside `ServerWsRpcGroup.of({...})`, plus its import                                                                                      |
| `apps/server/src/server.ts`                                  | `Layer.provideMerge(PluginHost.layerAll),` before `layerRuntimeServices`, plus its import                                                                           |
| `apps/server/src/mcp/McpHttpServer.ts`                       | `PluginHost.layerMcp(toolkitRegistration),` inside the exported `layer`, plus its import                                                                            |
| `apps/server/src/observability/RpcInstrumentation.ts`        | `...PLUGIN_RPC_SUBSYSTEMS,` in the subsystem map, plus the import                                                                                                   |
| `apps/server/src/auth/RpcAuthorization.ts`                   | `...PLUGIN_RPC_SCOPES,` inside `RPC_REQUIRED_SCOPES`, plus its import                                                                                               |
| `apps/server/src/mcp/toolkits/worktree/registration.test.ts` | the `PluginHost` and `PluginSupervisor` mocks in the service list, plus their imports                                                                               |
| `packages/client-runtime/src/rpc/client.ts`                  | `\| PluginSubscriptionRpcTag` in `EnvironmentSubscriptionRpcTag`, plus its import                                                                                   |
| `packages/client-runtime/package.json`                       | the `./plugins/rpc` and `./plugins/kanban` entries at the end of `exports`                                                                                          |
| `apps/mobile/src/Stack.tsx`                                  | `SettingsKanbanBoard` at the end of `SettingsContentStack`'s screens, plus its import                                                                               |
| `apps/mobile/.../SettingsProjectOverviewRouteScreen.tsx`     | in `features/settings/`: `<KanbanBoardEntries />` between the Project and Checkouts sections, plus its import                                                       |
| `apps/web/src/routes/_chat.board.tsx`                        | the kanban board's own route, its search read by `validateBoardSearch` in `plugins/kanban/`; a new plugin screen uses `/plugins/<id>` instead                       |
| `apps/web/src/components/sidebar/mainAppLocation.ts`         | `/board` and the `/plugins` paths in `isSidebarUtilityPage`                                                                                                         |
| `apps/web/src/components/sidebar/SidebarChrome.tsx`          | the board's `SidebarUtilityItem`, gated on `kanbanSupportedAtom`, and `<PluginSidebarEntries />` after the Usage entry, plus imports                                |
| `apps/web/src/components/CommandPalette.tsx`                 | the board's `actionItems.push` block (Open board, Find decision), gated the same way, plus imports                                                                  |
| `apps/web/src/components/chat/ChatHeader.tsx`                | `<ThreadDecisions ... />` after the breadcrumb, the thread's decision count, plus its import                                                                        |
| `apps/server/src/orchestration-v2/toolOutputImageBytes.ts`   | `export function carriesImage`, the one exported function: does a record hold image bytes or the size stripping left, so the estimate matches what ingestion stores |
| `third-party-licenses.config.json`                           | the `Caveman reply rules` and `Ponytail ladder` entries at the end of `customNotices`, so the adapted policy text is credited in the app's license list             |
| `scripts/build-desktop-artifact.ts`                          | in `createBuildConfig`, unsigned Mac builds get `identity: "-"`, `hardenedRuntime: false` and no GitHub update feed, plus their tests                               |
| `packages/provider-core/.../orchestrationInstructions.ts`    | `export let` on `T3_CODE_ORCHESTRATION_INSTRUCTIONS` and `setPluginOrchestrationInstructions` at the end, which the host calls with the capture rule                |
| `apps/web/src/components/chat/ComposerCommandMenu.tsx`       | `\| SavedPromptComposerItem` at the end of `ComposerCommandItem`, plus its import                                                                                   |
| `apps/web/src/components/chat/ChatComposer.tsx`              | `composerMenuItems = useSavedPromptMenuItems(...)` after the menu items' `useMemo`, renamed `builtInComposerMenuItems`, plus its import                             |
| `apps/web/src/components/chat/ChatComposer.tsx`              | the `saved-prompt` branch in `onSelectComposerItem`: `pickSavedPrompt(...)`, whose callback inserts the body as the skill branch does                               |
| `apps/web/src/components/chat/ChatComposer.tsx`              | in `submitComposer`, `const sentPrompt = promptRef.current;` and, once `didDispatch`, `countSavedPromptUses(...)`                                                   |
| `apps/server/src/orchestration-v2/WireProjection.ts`         | `withCapturedRecord(item, ...)` around a dynamic tool's compact output, plus its import                                                                             |
| `apps/web/.../chat/MessagesTimeline.logic.ts`                | the message row's `capturedRecords`: its field, the `capturedRecordsByRun` call, its value and its equality line, plus imports                                      |
| `apps/web/.../chat/MessagesTimeline.tsx`                     | `<RecordedThisTurnCard />` after `AssistantChangedFilesSection`, plus its import                                                                                    |

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
  `<T3 home>/wiki/<project-slug>/`; the folder is changeable per project from the board. The web
  board shows every project's board under the sidebar's project scope
  (`uiStateStore.sidebarProjectScopeKey`, read and set, never edited): `kanban.boards` reads each
  project's board folder and whether a board is there without creating any, and the client
  subscribes to each board on its own, so a change re-sends one project's board and a project
  without one gets no folder or watcher.
  Its own database, `plugins/kanban.sqlite`, holds the emergency stop (`StopGate`, which anything
  that starts a thread must ask first; the spec drafting thread is the one launch that asks so far)
  and spec attempts. The `writers` sweep raises an attention flag when two agents write one
  project, and the `decisions` sweep one per conflicted decision, keyed
  `decision:<projectId>:<category>/<id>`; it sees only projects the store has loaded, so a flag on
  one not loaded since the server started stays until the store next loads it. Done also needs a
  decision listing the issue or a `noDecision` reason, and no open finding, for an issue carrying
  `closureCheck`, which every new issue does; files from before have none and stay exempt. A
  settled or merged thread's card failing it gets a `closure_held` flag, keyed
  `closure:<projectId>:<issueId>`, instead of Done, and the `closure` sweep clears it once the card
  passes. The `findings` sweep keeps one `unowned_finding` flag per project, keyed
  `findings:<projectId>`, counting the findings with no review on its unarchived Triage cards
  captured three or more days ago: a finding's reviewer owns it, so any review takes it off the
  count. It reads every project through `KanbanStore.issues`, which reads a board that is not
  loaded once from its issue files and leaves it unloaded: no folder, watcher or archiving, so a
  tick costs no retained board and a dry run changes nothing.
  `kanban.attention.list` feeds the strip above the board from the project's open host
  flags, its threads' pending questions and permission requests, and, while routing runs, its
  routing mismatches; `kanban.attention.listProjects` does the same for several projects with one
  read of the flags and lists a `policy:*` flag, which every project matches, once. The thread
  header's decision count reads `kanban.listDecisions` with `thread`, which answers none for a
  project with no board folder and creates none, and re-reads when the thread's latest run starts
  or ends rather than following the board.
  `kanban.ticket.specify` (MCP `kanban_ticket_specify`) checks a Triage or
  Inbox issue's description against the Goal, Approach and Acceptance format, or starts a plan-mode
  drafting thread on routing's cheap tier whose final message the plugin's reactor checks when the
  run ends; a valid spec becomes the issue's criteria and admits it as `spec`, and the description
  is never edited. Mobile shows one project's board as a read-only list grouped by column, from
  the Board row on a project's overview, under the same attention rows; it and the web board share
  the board and active-plugin atoms, the attention atoms' re-read signal and the strip's row model
  in `packages/client-runtime/src/plugins/kanban.ts`, and the contract's
  `KANBAN_ATTENTION_KIND_LABELS` names each kind, so a new kind needs a label there and nothing per
  client. A finding, a problem an agent found outside its task, lives in its issue's frontmatter,
  on the issue it concerns or on a Triage issue labeled `finding` opened for it
  (`kanban/findings/`); `finding_capture` needs a `finding_search` the same thread made in the last
  30 minutes, kept in memory, so after a restart an agent searches again. While kanban runs, the
  host appends the capture rule (`plugins/CaptureRule.ts`), when to record a decision, a finding, a
  correction or a knowledge page, to the orchestration instructions, which
  every adapter sends only to a turn with the `t3-code` MCP server. Each line is dropped while its
  plugin is off. Pi bakes that text into its extension at import, before the host starts, and Muse
  gets none, so neither sees the rule. The wire projection reads the record each completed capture
  call made, a decision from `kanban_write`, `finding_capture`, `learning_correction_add`,
  `knowledge_propose` or `prompt_save`, from the call's own input and output and adds it to the
  call's compact output as `capturedRecord` (`plugins/capturedRecords.ts`), because that output
  otherwise keeps only ids the core knows. The web's **Recorded this turn** card under a run's last
  reply lists them from the tool items it already has (`apps/web/src/plugins/recorded/`); a record
  shows the state it was made in. Mobile does not show it, having no screen to open most records.
  Server: `apps/server/src/plugins/kanban/`. Contracts: `packages/contracts/src/plugins/kanban.ts`.
  Web: `apps/web/src/plugins/kanban/`. Mobile: `apps/mobile/src/features/kanban/`. User guide:
  [Kanban board](./user/kanban.md).
- **telemetry**: the eighteen efficiency measures of #1, #35 and #36 over a project's window, from the
  `telemetry.measures` gateway method and the `telemetry_measures` MCP tool. Its reactor keeps
  runs, tool calls, threads and provider turn token usage from the event log in the plugin's own
  tables, and pure functions in `measures/` compute each measure from those rows; cost is priced
  with the rate table the Usage page saves. A measure whose input is not recorded, or comes from a
  plugin that is off, answers `unavailable` with the reason. Migration 2 drops
  the reactor's cursor so the new tables fill from the first event; a request waits a few seconds
  for the reactor to catch up, and past that every measure answers `unavailable`. Where
  compaction before the upgrade kept a later thread event in place of a `thread.settled`, who
  settled is lost, and a thread settled by hand that way counts as an accepted outcome only if a
  pull request merged. With a `tier`, only the runs on that routing tier's provider instance and
  model count, and `context_efficiency` (output tokens per turn) answers only then; migration 3
  replays the log to record each run's instance. The `telemetry/budgets` sweep judges each budget,
  one measure for one tier, over the last seven whole UTC days per project, writes a
  `budget_events` row only when its state changes, and raises or clears a `budget_breach`
  attention flag. `tool_output_total` and `tool_output_max_per_call` size each tool call's output as
  characters over four, an inline image as 1,500, from the sizes the reactor stores beside each
  tool call (migration 4 adds them and replays the log), and carry per-tool and largest-result
  `detail` through `telemetry.measures` and the `telemetry_tool_output` MCP tool. They read no
  tier, so the sweep asks for them without one: the default budget on the largest result names
  `standard` only because a budget needs a tier, and judges every run, routing plugin on or off. A
  call a provider's subagent makes has no run: the reactor keeps it with the item's own time
  (migration 4), the two measures count it, and the per-run measures and a tier leave it out.
  `knowledge_reuse` is the share of runs that started in the window and edited a file that first
  read a path under `KNOWLEDGE_DIRECTORY` (`.knowledge/`), by tool call ordinal. `MeasureService`
  reads the knowledge plugin's `KnowledgeStore` where it runs only to count the project's accepted
  pages, so the measure answers `unavailable` while that plugin is off or the project has none. It
  is a rate, so the learning regression sweep compares it.
  `deterministic_work_share` and `extraction_candidates` (`measures/repeatedWork.ts`) find work a
  project's runs repeat in at least three threads: one tool call's shape, or up to six in a row,
  ranked by estimated tokens with the form it suits (a script, hook, MCP tool, scheduled task,
  context file or skill). The `telemetry_extraction_candidates` MCP tool lists the twenty costliest
  and the report five; nothing writes to the repo. A shape needs more than the earlier columns, so
  migration 5 adds each call's provider turn, which groups a subagent's calls with no run, its
  search pattern, a dynamic tool's input keys, and the input's size and sha256, never the input,
  and replays the log; a call a compaction removed before then has no shape. A command's shape
  puts quoted strings as `<str>`, and only 512 characters of a command line are kept, so an
  interpreter's inline script (`node -e`, `python3 -c`, a heredoc) and any command line that long
  are shaped by that sha256 instead, `script:<program>:<digest prefix>`, and a candidate's example names the stored calls, never their text. Absolute paths that resolve under the project's
  directory, which `MeasureService` reads from `ProjectService` when it is built, are made relative
  to it. Neither measure reads a tier; the share is a rate the regression sweep compares, the count
  a volume it does not.
  `telemetry.report` and the `telemetry_report` MCP tool fold a project's range
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
  while changes are requested, and threads reopened after settlement. `KanbanStore.write` also
  records a done ticket it reopens, on the thread linked to it last, through
  `producers/ticketReopens.ts` and `Effect.serviceOption`, so a reopen while learning is off
  records nothing. A ticket can link any thread id, so the reopen is recorded only when the core's
  thread shell places that thread in the ticket's project. Agents read and add them over MCP. A correction declares a failure mode only
  when its source names the cause: a review verdict, a person, the security scan (`security`) or a
  reopened ticket (`defect` for a defect, `unclear_spec` for a scope change); a provider failure
  never does. Two sweeps turn corrections with a declared failure mode into learning items, one
  per mode per project, routed by fixed rules on the mode to an owner kind, and hand each item
  over through one promotion record, at least once, keyed by the record's id so a promoter can
  drop a repeat. A written draft is `in_review` until someone other than its proposer adopts or
  rejects it (`ItemStore.reviewPromotion`): the proposer is `supervisor` when the rules picked the
  owner kind and `user` when a person did, a client's verdict through `learning.promotionReview`
  is `user`'s, and an agent's through the `learning_promotion_review` MCP tool is
  `thread:<id>`'s, so a person cannot adopt a handover a person routed. Only adoption promotes the
  item. A rejection, or `learning.promotionRollBack` (MCP `learning_promotion_rollback`) of an
  adopted record, reopens the item, and from then on the rules leave it and nothing more goes to
  that owner kind. The `reviews` sweep keeps a `promotion_review` flag,
  `promotion:<projectId>:<promotionId>`, for each record in review whose item still wants it, with
  a `plugin` action that opens the item. Migration 8 adopts records delivered before reviews at
  their delivery time. The plugin registers the promoters for `project_knowledge` and `policy` itself,
  from `knowledge/promoter.ts` and `policy/promoter.ts`, because a plugin's layer cannot see the
  registry of one it does not depend on. Each reaches its plugin's service with
  `Effect.serviceOption` when the sweep runs and hands over a draft: a knowledge page keyed
  `learned-<mode>-<item id>`, or a policy version keyed `learned-<mode>`. A promoter has an
  `available` check, false while its plugin is off, and the registry's `ownerKinds` leaves such a
  kind out, so its records wait without counting an attempt, as a kind with no promoter does; the
  report's `promoters` is the same list. The `prompt` kind goes to the plugin's own prompt library
  (`prompts/`): saved prompts and workflows per project, `active`, `proposed` or `archived`, with
  append-only versions and a use count. `PromptStore.proposeFrom` saves a sweep's proposal once per
  project and source key (`promotion:<id>` for a promotion), in the transaction that looks for it.
  Lists and searches filter in SQLite and answer with bounded summaries carrying a 200-character
  preview, so a library's bodies never cross the socket together; the body comes with one prompt,
  whose detail lists its latest 20 versions as previews too. Agents
  reach the library with `prompt_search`, `prompt_save` and `prompt_get`; a save is proposed and
  needs a search id from the last 15 minutes, kept in memory, so it checked for a duplicate first.
  People save, edit, revert, accept, archive and unarchive through the `learning.prompt*` gateway
  methods on the Learning screen's Prompts tab. The web composer's `/` menu reads the thread's
  project's active summaries when it opens and lists those whose title matches, most used first;
  the tab re-reads that list after each change. Picking one loads the prompt and inserts its
  latest body, or nothing once it is no longer active, and a send whose message still holds a body
  picked into that draft calls `learning.promptsUse` to count a use
  (`apps/web/src/plugins/learning/composerPrompts.ts`). The `regressions` sweep compares each
  project's telemetry measures over the last seven whole UTC days with the seven before, once a
  day, and opens or strengthens an `efficiency_regression:<measure>` item, with no owner kind, for
  each measure worse by its threshold in `regressions/thresholds.ts`, except a volume measure
  such as `tool_output_total`, which that file lists as not compared; with telemetry off it does
  nothing. The `outcomes` sweep checks each adopted bet once its 28 days after adoption are
  complete: it counts the project's corrections declaring the item's mode in the 28 days before
  and after the promotion's `adopted_at`, writes one `promotion_outcome` row, and raises a
  `promotion_ineffective` flag when three or more recurred after and more than half as many as
  before, or a `promotion_settled` flag when none did, keyed
  `promotion:<projectId>:<promotionId>` (the rule is `judge` in `compare.ts`). Below three before
  there is nothing to compare. A verdict is permanent, so the sweep is built with the learning
  reactor's `drain` and judges nothing, counting what it held back, until the reactor holds every
  committed event and `host_reactor_failure` is empty. A person setting the item's disposition
  after the adoption answers the flag, so none is raised, and the next tick clears one that is
  open, as it does once the record is rolled back; the sweep never closes or reroutes an item, and
  never judges `local_only`. The `unclassified` sweep runs after classify and keeps one
  `unowned_finding` flag per project, keyed `corrections:<projectId>`, counting the corrections
  classify left `unclassified`, provider failures aside, that are seven days old and still in the
  Corrections tab's 90-day window, which ends at the next hour, so a counted one can always be
  declared there.
  `learning.correctionDeclare` (MCP `learning_correction_declare`, and the Corrections tab)
  declares a review failure mode, never `security`, for one that has none and clears its
  classified mark, so the next tick classifies it before the count. Server:
  `apps/server/src/plugins/learning/`. Contracts:
  `packages/contracts/src/plugins/learning.ts` and `prompts.ts`. Web: `apps/web/src/plugins/learning/`, the Learning screen at `/plugins/learning` with the items, corrections, prompts and reviews of a project; `recordId` opens an item, or a prompt on the prompts tab. No mobile screen, and the mobile composer does not list prompts. User guide: [Learning](./user/learning.md).
- **policy**: reviewed working rules per project (`*` is the whole environment), versioned in the
  plugin's database and rendered as one marked block each, with `<state dir>/RULES.md` ahead of
  the body, into the instruction file each agent reads from the user's home. Verify re-reads the
  block. `policy.list` reads, with every version and each agent's file re-read but nothing marked
  verified; `policy.create`, `.accept`, `.install` and `.verify` are operate methods, and the
  `policy_list` MCP tool reads. A supervisor sweep installs and verifies accepted policies an
  agent lacks or holds under older rules, but only while no run is active on the project (any
  run, for `*`). After its installs the same sweep reads each recorded delivery's file once, even
  while a run is active, and keeps one `delivery_drift` flag, `policy:<projectId>:<agent>:<path>`,
  for every project and file whose block was edited or deleted since its install, naming the
  project's blocks; it never writes the block, and an install makes the next tick clear the flag. A
  `*` policy affects every project, so its flag is on every board. It reads the files itself because
  `verify` stamps `verified_at`, which a dry run must not. The first start seeds `*` /
  `ponytail`, the six-question ladder, and `*` /
  `caveman`, the terse reply rules, each unless a policy of that key exists in any state; the
  review plugin refuses a `convention` summary that starts with `rung:` and names none of the six
  rung ids. The kanban spec drafting thread's first message starts with the accepted `*` /
  `ponytail` body under `## Before you add anything`, read through `Ponytail.current` with
  `Effect.serviceOption`; it is unchanged while no version is accepted or `policy` is off, and never
  carries the `caveman` body, which the instruction file already does. `PolicyService.createForPromotion` is `create` for a learning promotion: the draft and
  a `policy_promotion` row naming it commit together, so a second delivery of the promotion adds
  no version. Server: `apps/server/src/plugins/policy/`. Contracts:
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
  is the completion gate a ticket asks before it finishes; nothing calls it yet. The plugin's
  reactor tests the lines each root-run turn adds against six fixed patterns unless the project's
  security mode is `off`, and the `review/security` sweep records each finding as a `security`
  correction declaring the `security` mode, because a reactor sees only its own plugin's
  services; in `block` a finding refuses `review.request`, verdicts and `ReviewGate.check`, holds back the invalidation sweep's
  replacement request and keeps a `security_hold` flag until `review.security.ack`. The same sweep calls the reactor's
  `retryFailed` each tick and settles an event the reactor gave up on as a scan row, with a
  `scan_failed` finding in `block`; in `block` a turn the scan cannot read, a stopped or failed
  one included, is held as a `scan_failed` finding rather than passed. The checkpoint becomes visible
  before the reactor reaches it, so the reactor writes a `security_scan` row with each checkpoint's
  findings, and in `block` `review.request` (code `scan_pending`) and the invalidation sweep wait
  for that row. A checkpoint captured before `security_scan_since` never gets one and does not
  wait; the reactor records that time through `PluginReactor.start`'s `onCursorCreated`, in the
  transaction that creates its cursor from the newest event, so the boundary and the cursor agree.
  Server:
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
- **knowledge**: short markdown pages per project that a person accepted, each written to
  `<project>/.knowledge/<key>.md` and listed in one index block in the project's `CLAUDE.md`,
  `AGENTS.md` and `.github/copilot-instructions.md`, for the agents in use as the policy plugin
  resolves them. The block helpers both plugins use are in
  `apps/server/src/plugins/InstructionBlocks.ts`. Agents propose drafts with the
  `knowledge_propose` MCP tool, from a thread only, for a project the server knows, and read
  accepted pages with `knowledge_list`. `knowledge.accept` (from `draft`) and `.retire` (from
  `accepted`) move a page in one conditional update, so a request that lost a race is refused, and
  install at once; an install failure is their error, though the change stands.
  `knowledge.discard` keeps a draft as retired without writing. `knowledge.install` and `.verify`
  are gateway methods too. Each install records, per page file (`page:<key>`) and per agent's
  index block, the hash of what it wrote. The `knowledge/delivery` sweep writes only a component
  whose record differs from what the accepted pages render to and whose file still holds what was
  recorded, even with no agent in use, and only while no thread in the project has a run; a file
  edited by hand stays `drifted` in `verify` until a person installs. After the catch-ups the sweep
  keeps a `delivery_drift` flag, `knowledge:<project>:<delivery>:<path>` (the delivery being
  `page:<key>` or the agent), for each recorded page file and index block of an agent in use that
  `KnowledgeStore.drift` finds edited or deleted against its recorded hash, whether or not a run
  is active; it writes nothing, a file it cannot read keeps its own flag while the rest are still
  judged, and an install makes the next tick clear the flag. The learning plugin's promoter calls
  `proposeForPromotion`, which looks for a page whose source names the promotion and saves the
  draft with source `item` in one transaction: overlapping deliveries save one draft, and a
  repeat, whatever became of the draft, answers with it. Server:
  `apps/server/src/plugins/knowledge/`. Contracts: `packages/contracts/src/plugins/knowledge.ts`.
  Web: `apps/web/src/plugins/knowledge/`, at `/plugins/knowledge`. User guide:
  [Project knowledge](./user/knowledge.md).

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
It builds the Windows x64, macOS arm64 and Linux x64 desktop apps and CLI archives through
upstream's reusable build job on GitHub-hosted runners, and publishes them as a prerelease tagged
`v<version>-nightly.<date>.<n>`. None carry a publisher signature, which needs an Apple developer
account and a Windows signing certificate. The macOS app and CLI are signed ad hoc, which Apple
silicon needs to open them. There is no Intel Mac build.

Install the first copy by hand from the Releases page. An app installed from upstream keeps updating
from upstream, so it has to be replaced once. The `t3` CLI from one of these archives updates from
this fork as well.

Windows shows a SmartScreen prompt once because the build is unsigned: More info, then Run anyway.
From then on the app updates itself from this fork's releases on the nightly channel.

On a Mac, open the `arm64` DMG and drag the app to Applications. Gatekeeper blocks the first launch
because the app has no Developer ID. On macOS 14 and earlier, Control-click the app and choose Open.
On macOS 15 and later, try to open it once, then choose Open Anyway under System Settings > Privacy
& Security. The Mac app does not look for updates at all: macOS updates go through Squirrel.Mac,
which only installs an update signed to match the running app, and an ad hoc signature matches only
its own build. Install every nightly by hand from its DMG the same way.
