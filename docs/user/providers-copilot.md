# GitHub Copilot

GitHub Copilot CLI is a beta integration. T3 Code runs it through the CLI's
Agent Client Protocol server, which GitHub ships as a public preview, so Copilot
CLI 0.0.397 or newer is required and 1.0 or newer is recommended.

## Set up Copilot

1. Install the [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli)
   on the machine running the T3 Code server, for example
   `npm install -g @github/copilot`.
2. Run `copilot login` as the account that runs T3 Code. On a remote or headless
   server, the CLI offers a device code to enter in your browser.
3. Open **Settings → Providers** and select the environment. Copilot is on by
   default; set **Binary path** if `copilot` is not on the host's `PATH`, then
   refresh provider status. Turn the provider off there if you do not use it.

Provider status reports whether the CLI is signed in. While signed out, Copilot
shows a sign-in error until you run `copilot login` on the host and refresh.

### Custom session launchers

To start sessions through a wrapper, set **Session launcher** to its executable
or script in **Settings → Providers**. T3 passes `--acp` and the permission-mode
flags to it. The launcher must forward these arguments and standard input/output
to Copilot without writing other text to standard output.

**Binary path** still selects the regular Copilot CLI for version checks, skill
discovery, and updates. The session launcher handles ACP authentication checks,
conversations, model refreshes, and generated titles or commit messages. Clear
**Session launcher** to return to direct Copilot sessions. To keep both choices
available, add a separate Copilot instance and set the launcher only there.

## Sign-in and tokens

To use a token instead of the saved login, add a **GitHub token** to the Copilot
instance's environment in **Settings → Providers**. The CLI reads
`COPILOT_GITHUB_TOKEN`, then `GH_TOKEN`, then `GITHUB_TOKEN`, so a token already
exported for the T3 server also applies and takes priority over `copilot login`.
Fine-grained tokens need the **Copilot Requests** permission; classic tokens are
not accepted.

Instances on the same host share its Copilot login. Give an instance its own
`COPILOT_HOME` environment variable for a separate login and settings directory.

## Models and options

Copilot only reveals its model list and tuning options, such as reasoning effort,
once a session exists. Until then the picker offers **Copilot default**, the model
the CLI is configured with (`COPILOT_MODEL` or its `settings.json`). After signing
in, use **Refresh provider status** with models in **Settings → Providers**, or
**Refresh models** in the thread settings on mobile: T3 Code opens a short
Copilot session, reads its catalog, and closes it. The list also fills in on its
own when T3 Code starts, or the first time a Copilot thread runs if you were signed out. Switching models or options applies on the
next message in the same session. Model IDs Copilot does not list can still be
added under **Custom models**.

## Permissions and limitations

Copilot follows the shared [permission modes](./permission-modes.md). **Supervised**
and **Auto-accept edits** show Copilot's permission requests in the conversation
and T3 Code answers them by the mode. **Auto** approves every request, because
Copilot has no automatic reviewer of its own. **Full access** launches Copilot with
its own `--allow-all` switch, so nothing is asked at all.

The Plan and Build toggle works: in Plan, T3 Code instructs Copilot to investigate
without editing and switches to Copilot's plan mode when the CLI offers one.

Permissions you saved in Copilot itself, such as a project's always-allow rules,
still apply, so those actions do not ask again.

Copilot can use T3 Code's tools. Its project, personal, plugin, and built-in
skills appear in the composer's `$` menu, and its built-in commands such as
`/context`, `/usage`, and `/review` appear under **Provider** in the `/` menu.
Use T3 Code's own `/model` and `/plan` instead of Copilot's. The Usage page reads Copilot's session logs under `~/.copilot`
or `COPILOT_HOME`. Conversation rewind is unavailable: a rollback restores files
and starts a fresh Copilot session.

Updates can run from **Settings → Providers** when T3 Code recognizes the Copilot
launcher; otherwise run `copilot update` on the host.
