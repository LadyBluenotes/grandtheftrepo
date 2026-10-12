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
