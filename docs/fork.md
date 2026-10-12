# Fork notes

This fork adds plugins on top of upstream `pingdotgg/t3code`. Plugins live in their own
directories and never edit an upstream file. Upstream is merged nightly by
`.github/workflows/sync-upstream.yml`; a conflict opens a pull request from `sync/upstream`.

## Where plugin code lives

- `apps/server/src/plugins/` holds the host (`PluginHost.ts`, `Plugin.ts`, `registry.ts`) and one
  directory per plugin.
- `packages/contracts/src/plugins/` holds each plugin's schemas and RPC definitions.
- `apps/web/src/plugins/` holds each plugin's screens.

Enabled state is `plugins.json` under the server state directory. A missing entry means enabled.
Changes apply on the next server start.

## Upstream seams

These are the only lines upstream files carry for the plugin system. A merge conflict in one of
them is resolved by keeping the line.

| File                                                         | Line                                                                                      |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `packages/contracts/src/rpc.ts`                              | `...PLUGIN_RPCS,` inside `RpcGroup.make(...)`, plus its import                            |
| `packages/contracts/src/clientRpcPermissions.ts`             | `...PLUGIN_GUARDED_RPC_SCOPES,` inside `CLIENT_GUARDED_RPC_SCOPES`, plus its import       |
| `packages/contracts/src/index.ts`                            | `export * from "./plugins/host.ts";`                                                      |
| `apps/server/src/ws.ts`                                      | `...PluginHost.handlers,` inside `ServerWsRpcGroup.of({...})`, plus its import            |
| `apps/server/src/server.ts`                                  | `Layer.provideMerge(PluginHost.layerAll),` before `layerRuntimeServices`, plus its import |
| `apps/server/src/mcp/McpHttpServer.ts`                       | `PluginHost.layerMcp,` inside the exported `layer`, plus its import                       |
| `apps/server/src/observability/RpcInstrumentation.ts`        | the two `PLUGIN_WS_METHODS` rows in the subsystem map, plus the import                    |
| `apps/server/src/mcp/toolkits/worktree/registration.test.ts` | the `PluginHost` mock in the service list, plus its import                                |

Web seams are added when the first plugin screen lands.

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
