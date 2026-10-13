# Weekly report

Each project with a default model gets a **Weekly report** thread. Every Monday at 09:00, in the
server's time zone, an agent posts a page there covering the last seven whole days (UTC):

- **Delivered**: threads settled with a merged pull request.
- **Review findings**: reviewers' verdicts, by outcome and failure mode.
- **Decisions**: learning items whose owner or state you set.
- **Knowledge changes** and **Prompt changes**: lessons handed to project knowledge or to prompts.
- **Failures**: corrections recorded, by kind.
- **Pull requests**: linked pull requests that are open, or merged or closed that week.
- **Unresolved**: open learning items, and open pull requests with changes requested.
- **Needs attention**: open attention flags on the project and its threads, such as budget
  breaches.
- **Efficiency**: the project's efficiency measures for the week.

Each section lists up to 20 entries with the full count. A section whose plugin is turned off says
so instead of showing data. An archived thread's pull requests appear only when the thread settled
that week or its latest merge was that week.

The report is an ordinary scheduled task, created when the server starts. Change its time, prompt
or model, or turn it off, like any other scheduled task; T3 Code does not change it again. A
deleted task comes back with a new thread at the next start, so turn it off to stop it. Projects
added later get theirs at the next start. It runs in **Supervised** mode.

Agents can build the same report for any range with the `telemetry_report` tool. Both need the
telemetry plugin: turning it off on the Plugins page removes the tool and stops new report tasks.
