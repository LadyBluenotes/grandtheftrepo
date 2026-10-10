# GitHub Copilot

GitHub Copilot CLI is a beta integration and is disabled by default. T3 Code runs
it through the CLI's Agent Client Protocol server, which GitHub ships as a public
preview, so Copilot CLI 0.0.397 or newer is required and 1.0 or newer is
recommended.

## Set up Copilot

1. Install the [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli)
   on the machine running the T3 Code server, for example
   `npm install -g @github/copilot`.
2. Run `copilot login` as the account that runs T3 Code. On a remote or headless
   server, the CLI offers a device code to enter in your browser.
3. Open **Settings → Providers**, select the environment, and enable **Copilot**.
   Set **Binary path** if `copilot` is not on the host's `PATH`, then refresh
   provider status.

Provider status does not check your login. If you are signed out, messages fail
until you run `copilot login` on the host.

## Sign-in and tokens

To use a token instead of the saved login, add a **GitHub token** to the Copilot
instance's environment in **Settings → Providers**. The CLI reads
`COPILOT_GITHUB_TOKEN`, then `GH_TOKEN`, then `GITHUB_TOKEN`, so a token already
exported for the T3 server also applies and takes priority over `copilot login`.
Fine-grained tokens need the **Copilot Requests** permission; classic tokens are
not accepted.

Instances on the same host share its Copilot login. Give an instance its own
`COPILOT_HOME` environment variable for a separate login and settings directory.

## Models

The picker offers **Copilot default**, which uses the model the CLI is configured
with (`COPILOT_MODEL` or its `settings.json`). Copilot does not list its models
before a session starts, so add the model IDs you want to switch between under
**Custom models** in the instance settings, for example `gpt-5.3-codex` or
`claude-sonnet-4.5`. The model strings are listed under `--model` in `copilot help`.
Selecting a custom model switches the session when Copilot exposes a model
setting; otherwise the session keeps its configured model.

## Permissions and limitations

Copilot offers three [permission modes](./permission-modes.md). **Supervised** and
**Auto-accept edits** show Copilot's permission requests in the conversation and
T3 Code answers them by the mode. **Full access** launches Copilot with its own
`--allow-all` switch. **Auto** is not offered because Copilot has no automatic
approval reviewer; a thread already set to Auto runs as Supervised.

Permissions you saved in Copilot itself, such as a project's always-allow rules,
still apply, so those actions do not ask again.

Copilot can use T3 Code's tools. Slash commands and skills Copilot advertises run
when sent as a message, such as `/context`, but they do not appear in the
composer's menus. The Usage page does not include Copilot history, and
conversation rewind is unavailable.

Updates can run from **Settings → Providers** when T3 Code recognizes the Copilot
launcher; otherwise run `copilot update` on the host.
