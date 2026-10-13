# Kanban board

The board holds the work that is not a thread yet: bugs an agent found, ideas you want to get to,
and the decisions you made along the way. Open it from **Board** in the sidebar's utility row or
with **Open board** in the command palette (`Cmd/Ctrl+K`). Pick a project at the top; the board
remembers your last one.

## Columns

Cards move left to right through **Triage**, **Inbox**, **Todo**, **In progress**, **In review**
and **Done**. Drag a card to another column, or change its status in the card panel.

- **Triage** holds what was just found. Each card shows how far it was verified: unverified,
  partial or verified.
- **Inbox** holds reproduced work that waits for you. Agents can move a card here, but only you can
  move it on to **Todo**. Until you do, it cannot be started and agents cannot attach a thread to it.
- **Todo** is released work. **Start thread** on a card opens a new thread draft in the project with
  the ticket filled in; choose a model and mode, then send as usual.
- A card follows its threads from there: starting a thread moves it to **In progress**, a finished
  turn to **In review**, and a merged pull request or settled thread to **Done**. Automation only
  moves cards forward and never out of Triage or Inbox. Dragging a card anywhere always wins.

Moving a card out of **Done** asks why: the work was wrong, or the ask changed. The reason stays on
the card and in its log.

A card that needs you shows a red marker. An agent blocks a card with a reason when it cannot
continue; **Needs you** at the top filters the board down to those cards, and **Unblock** in the
card panel clears it.

Done cards are archived after seven days. **Archived** at the top shows them; from the card panel
you can unarchive or delete an archived card.

## Waiting on you

A strip above the columns lists what in the project is waiting on you, oldest first: questions and
permission requests agents are waiting on, and flags other plugins raise, such as two agents
writing the project at once, a stale review, a budget breach, or a thread that ran another model
than routing recommended over the last seven full days (UTC). Each row names its thread, or the
project for a budget, and has a button that takes you there, or to the Plugins page for a budget.
Rows cannot be dismissed: a row leaves on its own once its request is answered or its cause clears.
Requests on settled or archived threads are not listed. A new flag shows up within half a minute
while the board is open, and the strip is hidden while nothing waits.

## Cards

Click a card to open it. The panel holds the title, status, priority (P0 to P5), verification,
free-form labels, a markdown description, the threads working on it, the decisions about it, and
a log of every status change, note and block with who made it and when. Add a note at the bottom
of the log.

**Acceptance criteria** define done. Add one sentence per thing that must be true, check them off
as they hold, and the card cannot move to Done while one is open, whether you drag it or a thread
settles. A new thread started from the card sees the checklist. The **tier** (cheap, standard,
strong) records the model class you expect the work to need.

Create a card with the **+** in a column header. Cards you create start in that column; cards an
agent files start in Triage.

## Decisions

**Decisions** at the top switches the board to the project's decisions: calls made for or against
something, with the reason and the tickets they concern. They are grouped into categories you name,
such as `auth` or `performance`, and filterable by category. Record one from the decisions view or
from a card's panel, and edit or delete it later.

A new thread started from a card is told which decisions concern its ticket and which categories
exist, so the agent can look them up instead of relitigating them.

## Emergency stop

An agent can set the emergency stop to hold back everything the supervisor would start from the
board. While it is set, a banner at the top of the board says so, with a **Clear** button. The stop
does not interrupt running agents, and starting work yourself, including dragging a card to
**In progress**, is never blocked. It is stored, so it survives a restart. Setting it twice, or
clearing it when it is not set, changes nothing. Nothing on the board starts threads by itself
yet, so the stop only matters once something does.

## Agents

Agents reach the board through three MCP tools. `kanban_list` lists issues or decisions, or one of
them in full. `kanban_write` files an issue, moves it, adds a note, blocks it when it needs you,
links the calling thread, or records a decision. Agent-filed issues land in Triage. `kanban_stop`
sets or clears the emergency stop.

## Files

Everything on the board is a file on the environment running the project: one markdown file per
issue with its fields in frontmatter and the log at the end, and one YAML file per decision
category. They live under `<T3 home>/wiki/<project>/` in `issues/` and `decisions/`. Use the
folder button at the top of the board to choose another folder for a project. Edits made in an
editor show up on the board right away, and agents may edit the files directly.
