# Policies and reviews

## Policies

A policy is a short set of working rules that agents read before they start. Each policy has a key
and numbered versions. A new version is a draft until someone accepts it, and only the accepted
version reaches agents. The project `*` is the whole environment, so its policies apply to every
project; any other project's policies apply to that project.

The server writes each accepted policy into the instruction files that Claude, Codex and Copilot
read from your home directory. It does this between runs, so a policy that changes while an agent is
working arrives once that work is done. Agents list policies, with the version each agent holds,
using the `policy_list` tool.

### The Policies screen

While the policy plugin runs, **Policies** is in the sidebar. Pick the environment or one project
at the top: the environment's policies apply everywhere, a project's to that project. The list shows
each policy with the version on show, its state and when it last changed; a draft waiting above the
accepted version is marked.

Open a policy to see its versions and accept one. The form below starts from the body on show, and
saving it adds a draft. Accepting a draft makes it current and the server delivers it between runs.
**New policy** starts one from an empty form; its key is lowercase letters, digits and dashes.

The learning plugin adds drafts here too: a recurring failure mode handed over to a policy or a
prompt arrives as a draft policy keyed `learned-<failure mode>` or `prompt-learned-<failure mode>`.
Review it, edit it by saving a new version, and accept it, or leave it as a draft.

Delivery shows, for Claude, Codex and Copilot, whether the agent's instruction file holds the
accepted version: `OK`, `Outdated` when the file holds a different version from the accepted one,
`Drifted` when the block was edited by hand, or `Missing` when nothing was installed in the file the
agent reads now or the file lost it. **Reinstall** writes the accepted version again; an agent whose
directory does not exist is skipped. The screen re-reads when you come back to it, so a change an
agent made through the `policy_*` tools shows then.

### The ponytail policy

The first time the policy plugin starts, it adds a policy named `ponytail` to `*` and accepts it, so
every agent is told to ask these questions, in this order, before adding anything:

1. `needed`: Does it need to exist? If not, do not add it.
2. `existing`: Is it already in this codebase? Reuse it.
3. `platform`: Does the standard library or platform do it? Use that.
4. `dependency`: Does an installed dependency do it? Use that. Add no dependency for a few lines.
5. `one_line`: Can it be one line? Write the line.
6. `minimum`: None of the above? Write the minimum that works.

`ponytail` is edited like any other policy: on the Policies screen, save a new version with your
own wording and accept it. Once a `ponytail` policy exists, in any state, the server leaves it alone,
so your version is never replaced. The questions are adapted from
[ponytail](https://github.com/DietrichGebert/ponytail) by DietrichGebert, used under the MIT
license; its notice is listed under [Open source licenses](./open-source-licenses.md).

### The caveman policy

The first time the policy plugin starts, it also adds a policy named `caveman` to `*` and accepts
it. It tells agents to reply tersely: answer first, with no greeting, plan announcement, recap or
offer of help, one idea per sentence, and code, commands, paths and error text word for word.
Security warnings, irreversible actions, ordered steps, questions back to you, and anything written
outside chat, such as code, comments, commits and docs, stay in plain full sentences. The rules are
adapted from [caveman](https://github.com/JuliusBrussee/caveman) by Julius Brussee, used under the
Apache License 2.0; its notice is listed under [Open source licenses](./open-source-licenses.md).

It reaches every thread of Claude, Codex and Copilot through the instruction files above, with
nothing to install. Cursor, Grok, OpenCode and Antigravity do not read those files, so it does not
reach them.

To switch the style off, open `caveman` on the Policies screen, save a new version with a neutral
body, such as `Reply in plain sentences.`, and accept it. The server delivers it between runs and
never replaces your version. Turning the policy plugin off does not remove a block already
installed.

## Reviews

A reviewing agent judges one checkpoint of another thread and gives its verdict with the
`review_verdict` tool: approve, or changes requested for one of six reasons. Work that fails one of
the ponytail questions is a `convention` verdict whose summary starts with `rung:` and the question's
id, such as `rung:dependency`. When several questions fail, the summary names the earliest, unless
another reason is more severe and is given instead. A summary that starts with `rung:` and names none
of the six ids is refused.

### Requesting a review

Ask the agent working in a thread to request a review when it finishes; it uses the
`review_request` tool. The request names the thread's latest checkpoint and stays open until a
reviewer gives a verdict on that checkpoint. Asking again before the thread changes returns the
same request. `review_requests` lists a thread's requests and where each stands.

A review describes the work as it was at its checkpoint. Once the thread changes after that, the
review is out of date: T3 Code marks the request stale, opens a new request at the latest
checkpoint, and that one needs its own verdict. An out-of-date review stays out of date, even if
you roll the thread back to the checkpoint it reviewed.

### Security scan

After each turn, T3 Code checks the lines the agent added for leaked secrets (AWS, GitHub and
OpenAI-style keys, and private keys), downloaded code run with `eval` or piped into a shell,
`${{ github.event.* }}` expressions in a GitHub workflow's `run:` steps, and shell commands built
from variables. Removed and unchanged lines are never checked, and the matched text is never
stored. Each project's security mode is `warn` unless changed: findings are recorded, and agents
list them with the `review_security_findings` tool. In `block`, a finding also holds the thread:
review requests and verdicts are refused, the thread cannot pass review, and it is flagged until
someone acknowledges every finding with the `review_security_ack` tool and a reason, which is kept
with the findings. A turn the check could
not read, such as one you stopped or one that failed, holds the thread the same way, listed as a
`scan_failed` finding, so look at that turn yourself before acknowledging it. A review request in
`block` also waits until the check of the thread's latest turn has finished; ask again a moment
later. `off` skips the check. The mode in effect when a turn is checked applies, which is when the
turn ends unless a failed check is retried later. There is no screen to change the mode yet.
