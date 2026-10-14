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
- **Inbox** holds reproduced work that waits for you. Agents can move a card here, but only you, or
  a valid spec (see [Agents](#agents)), can move it on to **Todo**. Until then, it cannot be started
  and agents cannot attach a thread to it.
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
writing the project at once, a stale review, a budget breach, a conflicted decision, a policy block
or knowledge file that was edited or deleted outside T3 Code, or a thread that ran another model
than routing recommended in the past seven days. A policy for the whole environment affects every
project, so its flag is on every board. Each row names its thread, or the project for a budget, a
decision, or a policy or knowledge file, and has a button that takes you there, or to the Plugins
page for those.
Rows cannot be dismissed: a row leaves on its own once its request is answered or its cause clears.
Requests on settled or archived threads are not listed. A new flag shows up when you come back to
the window or the board changes, and the strip is hidden while nothing waits.

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

**Decisions** at the top switches the board to the project's decisions: the calls made along the
way, with the reason and the tickets they concern. They are grouped into categories you name, such
as `auth` or `performance`, and filterable by category. Record one from the decisions view or from a
card's panel, and edit or delete it later.

Each decision has a state: proposed, accepted, rejected, deferred, conflicted or superseded. An
agent recording one also keeps the alternatives it weighed, each with why it was chosen or passed
over and whether that reason is permanent, holds only for now, or lacks evidence, and what would
make the call worth revisiting; they are in the decision's file. When one decision replaces
another, the old one stays, marked superseded and linked to its replacement; giving it another
state unlinks them, and a linked decision cannot be deleted. A conflicted decision waits in
[Waiting on you](#waiting-on-you) until its state changes. Every change is kept as a revision.
Decisions recorded as for or against something read as accepted, with that call as their one
alternative, chosen or rejected.

A new thread started from a card is told which decisions concern its ticket and which categories
exist, so the agent can look them up instead of relitigating them.

## On mobile

In the mobile app, **Board** on a project's overview in Settings lists its tickets grouped by
column, read-only: tap a ticket to open its thread, and pull down to refresh. The row appears only
when the server runs the board, and a ticket with no thread yet cannot be opened. The same
[Waiting on you](#waiting-on-you) rows sit above the columns, oldest first; tap one to open its
thread, while a row about the whole project, such as a budget breach, only shows its text. Nothing
can be dismissed from the phone either.

## Emergency stop

An agent can set the emergency stop to hold back everything the supervisor would start from the
board. While it is set, a banner at the top of the board says so, with a **Clear** button. The stop
does not interrupt running agents, and starting work yourself, including dragging a card to
**In progress**, is never blocked. It is stored, so it survives a restart. Setting it twice, or
clearing it when it is not set, changes nothing. While it is set, drafting a spec with a model is
refused; checking a spec you wrote still works.

## Agents

Agents reach the board through six MCP tools. `kanban_list` lists issues or decisions, or one of
them in full. `kanban_write` files an issue, moves it, adds a note, blocks it when it needs you,
links the calling thread, or records, changes or supersedes a decision; an agent must say why, and
cannot delete one. Agent-filed issues land in Triage. `kanban_decisions` searches decisions by their
words. `kanban_stop` sets or clears the emergency stop. Agents are told to record a decision
whenever they choose one approach over another, without being asked.

`kanban_ticket_specify` turns a rough card in Triage or Inbox into a spec. By default it starts a
drafting thread in plan mode on the routing plugin's cheap model; with `useExisting` it checks a
spec you wrote in the description instead, with no model. A spec has `## Goal`, `## Approach` (a
list of two to five steps) and `## Acceptance` (a `- [ ]` checklist), in that order, optionally
followed by `## Out of scope`, and no other headings. A valid spec becomes the card's acceptance
criteria and moves it to **Todo**; a malformed one leaves the card where it is and says why. The
description is never changed. `kanban_spec_get` shows the latest attempt and the column the card is
in now, which differs if you moved it while a draft was running, or says the card is gone if you
deleted it. If the drafting thread cannot be started (this includes the server stopping before it
was), or you edit the card's title or description, or delete the card, while it drafts, the attempt
is closed as malformed with the reason, and you run it again if the card is still there.

## Files

Everything on the board is a file on the environment running the project: one markdown file per
issue with its fields in frontmatter and the log at the end, and one YAML file per decision
category. They live under `<T3 home>/wiki/<project>/` in `issues/` and `decisions/`. Use the
folder button at the top of the board to choose another folder for a project. Edits made in an
editor show up on the board right away, and agents may edit the files directly.
