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
| `apps/server/src/mcp/McpHttpServer.ts`                       | `PluginHost.layerMcp(toolkitRegistration),` inside the exported `layer`, plus its import  |
| `apps/server/src/observability/RpcInstrumentation.ts`        | `...PLUGIN_RPC_SUBSYSTEMS,` in the subsystem map, plus the import                         |
| `apps/server/src/auth/RpcAuthorization.ts`                   | `...PLUGIN_RPC_SCOPES,` inside `RPC_REQUIRED_SCOPES`, plus its import                     |
| `apps/server/src/mcp/toolkits/worktree/registration.test.ts` | the `PluginHost` mock in the service list, plus its import                                |
| `packages/client-runtime/src/rpc/client.ts`                  | `\| PluginSubscriptionRpcTag` in `EnvironmentSubscriptionRpcTag`, plus its import         |
| `apps/web/src/routes/_chat.<plugin>.tsx`                     | one route file per plugin screen; the screen itself lives in `apps/web/src/plugins/`      |
| `apps/web/src/components/sidebar/mainAppLocation.ts`         | the plugin's path in `isSidebarUtilityPage`                                               |
| `apps/web/src/components/sidebar/SidebarChrome.tsx`          | the plugin's `SidebarUtilityItem`, gated on its `...SupportedAtom`, plus imports          |
| `apps/web/src/components/CommandPalette.tsx`                 | the plugin's `actionItems.push` block, gated the same way, plus imports                   |

## Plugin services and the type system

A plugin's layer is merged into the server only when the plugin is active, so the server's layer
chain never types its services as present. Anything outside the plugin's own layer that needs one,
such as a WebSocket handler (the RPC group requires every handler whether or not the plugin runs)
or an MCP handler layer, reads it with `Effect.serviceOption` and fails with the plugin's own
"inactive" error when it is absent. Declaring it as a `Tool` dependency or yielding the tag
directly makes the whole server require it and fails to typecheck. See
[`plugins/kanban/handlers.ts`](../apps/server/src/plugins/kanban/handlers.ts).

A plugin never imports `McpHttpServer`: that module imports the host, and the cycle leaves one of
them half-evaluated. The host hands `toolkitRegistration` to `ServerPlugin.mcp` instead.

## Plugins

- **kanban**: a board per project. Issues and decisions are files under
  `<T3 home>/wiki/<project-slug>/`; the folder is changeable per project from the board.
  Server: `apps/server/src/plugins/kanban/`. Contracts: `packages/contracts/src/plugins/kanban.ts`.
  Web: `apps/web/src/plugins/kanban/`. User guide: [Kanban board](./user/kanban.md).

`apps/web/src/routeTree.gen.ts` is generated and committed. A conflict there is resolved by running
the web dev server or build once, which regenerates it.
