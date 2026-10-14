# Learning

The learning plugin keeps track of work that went wrong: a turn that failed or was interrupted, a
review that asked for changes, a security finding, a ticket reopened after it was done. Each of these
is a correction. When the same failure mode recurs in a project, its corrections open a learning
item, and the plugin hands the item to whoever should act on it: the project's knowledge files, its
prompt library, or a policy.

Only a correction with a failure mode counts toward an item. A review verdict names one, a security
finding is **Security**, and a kanban ticket reopened from Done is a **Defect**, or an **Unclear
spec** when it was reopened for a scope change. A reopened ticket's correction goes on the thread
linked to it last, so a ticket with no thread records none. A failed or interrupted turn has no
failure mode: the provider, not the work, may be at fault.

While the plugin runs, **Learning** in the sidebar's **Plugins** menu opens its screen. Turn it on under
**Plugins**.
Pick a project at the top of the screen.

## Items

Each item is one failure mode in one project, with how many times it recurred and its state:

- **Open**: nothing acts on it yet.
- **Candidate**: it has an owner kind with something to hand over; the next sweep hands it over,
  and the handover waits for review.
- **Promoted**: its handover was adopted.
- **Closed**: a person closed it.

Open an item to see its evidence, where it was handed to, and its progress as steps from the
corrections through the handover and its review to the outcome, with the current step marked. From
there, set the owner kind, close the item, or reopen it. Candidate and promoted are not yours to
set: the owner kind makes an open item a candidate, and adopting its handover makes it promoted.
Once you set an item's owner kind or state, the rules leave it alone. **Local only** is an owner
kind with nothing to hand over, so an item with it stays open.

## What handing over does

Handing over writes a draft for you to review. Nothing is accepted for you.

- **Project knowledge**: a draft page titled `Learned: <failure mode>` on the **Knowledge** screen.
- **Policy**: a draft policy version on the **Policies** screen, keyed `learned-<failure mode>`.
- **Prompt**: a proposed prompt titled `Learned: <failure mode>` on the **Prompts** tab.

Each draft holds the item's reason and its latest five pieces of evidence. While the knowledge
plugin is off, items for project knowledge stay candidates; likewise policy items while the policy
plugin is off. They are handed over once it is on again.

## Reviewing a handover

A handover is reviewed before it is adopted, by someone other than whoever proposed it. The rules
propose a handover when they picked the owner kind, and you propose it when you set the owner kind
yourself. While a handover waits for review, the strip above the project's board flags it, and the
flag's button opens the item.

Read the draft, then choose under **Handover** in the open item:

- **Adopt**: the item becomes promoted, and the four weeks its outcome is judged on start now.
- **Ask for a revision**: the handover stays in review. Edit the draft where it waits, then review
  it again.
- **Reject**: the item reopens. Nothing more is handed to that owner kind; set another owner kind or
  close the item.

You can add a note to say why. A handover you proposed is reviewed by an agent instead: ask one to
review it with the `learning_promotion_review` tool.

**Roll back** undoes an adopted handover: the item reopens, nothing more is handed to that owner
kind, and its outcome is no longer judged. The draft stays where it was written; retire or discard
it there if it should go.

## Did the handover work?

Four weeks after a handover was adopted, the plugin compares the four weeks before the adoption with
the four weeks after, counting the project's corrections with the item's failure mode. A handover
made before reviews existed counts as adopted when it was handed over. If the mode came back at
least three times, and more than half as often as before, the strip above the project's board flags
it: the fix did not take. If it did not come back at all, the strip flags that too, so
you can close the item. Anything else raises nothing: a mode that fell by half or more, or that
recurred fewer than three times beforehand, leaves too little to judge. Nothing is closed or moved
for you. Closing the item or setting another owner kind answers the flag, and it clears on the
next sweep. See [Waiting on you](./kanban.md#waiting-on-you) for the strip.

## Corrections

The **Corrections** tab lists the project's corrections over the last 7, 30 or 90 days, with the
kind of event that recorded each one and its failure mode, if it has one. Narrow the list by kind
or mode, and open a correction's thread from its row.

## Prompts

The **Prompts** tab is the project's prompt library: prompts you send again and again, and
workflows, steps for an agent to follow in order. Search titles and bodies, or narrow the list by
state:

- **Active**: ready to use.
- **Proposed**: an agent or a learning item suggested it, and it waits for you to accept it.
- **Archived**: put away.

**New prompt** saves one, active at once. Open a prompt to accept it, archive it, or unarchive it.
Unarchiving brings back a prompt you had accepted as active, and one you never accepted as
proposed. Editing the title or body saves a new version; the latest 20 versions are listed, and
**Restore** saves a copy of one as the latest.

To use a prompt, type `/` in a thread's message box and part of its title: the menu lists the
project's active prompts that match, the ones you use most first. Picking one puts its latest text
into your message to edit; nothing is sent until you send it. Sending a message that still holds
the prompt's text counts a use. The mobile app does not list prompts.

Agents reach the library through the `prompt_search`, `prompt_save` and `prompt_get` tools. An
agent has to search before it saves, so it finds a prompt that already covers the work, and what it
saves is proposed until you accept it.

## Deterministic

Once a week the plugin looks at the work your agents kept repeating in each project, as the
telemetry plugin finds it (see [Usage](./usage.md)), and drafts up to five proposals to do it
without a model: work done the same way in at least four out of five runs, in at least three
threads, the costliest first. Each proposal's draft goes where its kind of work belongs:

- **Script**: a draft project action. Its command is the commands the agents ran, with `<str>` and
  `<n>` where strings and numbers differed. A script an agent wrote into the command line is never
  kept, so its line is a comment naming the program and the thread to copy it from.
- **Prompt**: a proposed workflow in the **Prompts** tab.
- **Knowledge page**: a draft page listing what runs read first, for you to replace with the facts
  they were looking for.
- **Scheduled task**: a paused task on the project's default model.
- **MCP tool** and **Hook**: these need code, so the draft is a card in the board's Triage column
  labeled `deterministic`.

The **Deterministic** tab lists them; open one to see its steps and draft. **Accept** applies the
draft: the action joins the project's actions, the prompt becomes active, the page is written, the
task turns on, or the card moves to Todo. Edit it there before you rely on it. **Dismiss** needs a
reason and withdraws a draft you have not acted on elsewhere. A dismissed proposal comes back only
when its work costs at least twice as much in a later week. While the knowledge or kanban plugin is
off, or the project has no default model for a task, a proposal waits without a draft; it gets one
once that is fixed.

While proposals wait for you, the strip above the project's board flags them, and the flag's
button opens this tab. Agents list proposals with `learning_deterministic_proposals` and dismiss one
with `learning_deterministic_dismiss`; only you accept.

## Reviews

With the review plugin on, the **Reviews** tab shows one thread's verdicts and review requests. See
[Policies and reviews](./policies-and-reviews.md#reviews) for how reviews work.
