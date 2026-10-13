# Project knowledge

Knowledge pages are short notes every agent should read before it changes code in a project: a
convention, a trap, or where something lives. Each accepted page is a markdown file in the
project, so it travels with the repository and reaches your teammates' agents too.

## Adding a page

1. Ask the agent working in a thread to propose one, for example "propose a knowledge page on how
   to run the tests here". It uses the `knowledge_propose` tool. A proposed page is a draft, and
   nothing is written to the project yet.
2. Open **Knowledge** in the sidebar and pick the project. Each draft shows its title and body,
   which you can edit before you accept it. **Discard** drops a draft you do not want.
3. **Accept** writes the page to `.knowledge/<key>.md` and adds a line for it to the index in the
   project's instruction files: `CLAUDE.md` for Claude Code, `AGENTS.md` for Codex and
   `.github/copilot-instructions.md` for Copilot. The index is one marked block that tells agents
   to read the page matching their task. The rest of each file is left exactly as it was, and a
   file that does not exist is created with the index alone.

Agents list the accepted pages with the `knowledge_list` tool.

## Changing or removing a page

**Retire** deletes the page's file and its line in the index. Retired pages and discarded drafts
are listed under **Retired**, where **Restore as draft** brings one back to accept again. To change
an accepted page, retire it, restore it, edit the draft and accept it.

## Delivery

A project's instruction files are written only for the agents set up on the machine that runs T3
Code: Claude Code, Codex or Copilot with its home directory present. **Delivery** shows, for each
one, whether its files are up to date, changed by hand, or missing, and **Reinstall** writes them
again. The pages in `.knowledge/` are written even when none of these agents is set up.

Accepting and retiring write the files at once. When that write fails, or an agent is set up
later, T3 Code catches up by itself once no thread in the project has a run, so the files never
change under a working agent. That catch-up leaves an edit made by hand to a page file or inside the
index block alone, and it shows as changed by hand. **Reinstall**, **Accept** and **Retire** rewrite
every accepted page and the index, so they replace such an edit.

Turning the knowledge plugin off on the **Plugins** page removes the screen and the tools after the
next restart. Pages and index blocks already in the project stay.
