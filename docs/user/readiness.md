# Plugin readiness

A fresh install runs every plugin, but most of them have nothing to do until something is set up:
routing has no models picked for its tiers, the weekly report has no task, caveman's proxy is not
running. The readiness checklist at the top of **Plugins** shows, in one place, what each plugin
needs and why a feature is quiet.

Pick a project in the checklist's header; checks about one project, such as its board folder or its
knowledge files, follow that pick. Each plugin has one row:

- **Needs attention**: a check found something to fix. Its sentence says what, and its button opens
  the screen where you fix it, such as the plugin's own screen, its settings on this page, the
  board, Usage or scheduled tasks.
- **Off**: the plugin does not run. The row says why: it is switched off, a plugin it needs is off,
  it failed to start, or it starts with the next server start.
- **Ready**: nothing to do. Ready checks are folded away; open them to see what was checked.

The checklist reads again when you open the page, when you come back to the window, and after you
change something on the page, such as a tier. Checks only look: they never install, start or change
anything.

Agents can read the same checklist with the `plugins_readiness` tool, so you can ask an agent why a
plugin is not doing anything. Without a project it uses the agent's own thread's project.

Some checks have no screen to fix them yet. A project with no saved security mode scans in `warn`,
and there is no screen to choose one; see [Policies and reviews](./policies-and-reviews.md#security-scan).
