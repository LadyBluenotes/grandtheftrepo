# Learning

The learning plugin keeps track of work that went wrong: a turn that failed or was interrupted, a
review that asked for changes, a ticket reopened after it was done. Each of these is a correction.
When the same failure mode recurs in a project, its corrections open a learning item, and the plugin
hands the item to whoever should act on it: the project's knowledge files, its prompt library, or a
policy.

While the plugin runs, **Learning** in the sidebar's **Plugins** menu opens its screen. Turn it on under
**Plugins**.
Pick a project at the top of the screen.

## Items

Each item is one failure mode in one project, with how many times it recurred and its state:

- **Open**: nothing acts on it yet.
- **Candidate**: it has an owner kind with something to hand over, and the next sweep hands it over.
- **Promoted**: it was handed over.
- **Closed**: a person closed it.

Open an item to see its evidence and where it was handed to. From there, set the owner kind, close
the item, or reopen it. Candidate and promoted are not yours to set: the owner kind makes an open
item a candidate, and handing it over makes it promoted. Once you set an item's owner kind or state,
the rules leave it alone. **Local only** is an owner kind with nothing to hand over, so an item with
it stays open.

## What handing over does

Handing over writes a draft for you to review. Nothing is accepted for you.

- **Project knowledge**: a draft page titled `Learned: <failure mode>` on the **Knowledge** screen.
- **Policy**: a draft policy version on the **Policies** screen, keyed `learned-<failure mode>`.
- **Prompt**: a proposed prompt titled `Learned: <failure mode>` on the **Prompts** tab.

Each draft holds the item's reason and its latest five pieces of evidence. While the knowledge
plugin is off, items for project knowledge stay candidates; likewise policy items while the policy
plugin is off. They are handed over once it is on again.

## Did the handover work?

Four weeks after an item was handed over, the plugin compares the four weeks before with the four
weeks after, counting the project's corrections with the item's failure mode. If the mode came
back at least three times, and more than half as often as before, the strip above the project's
board flags it: the fix did not take. If it did not come back at all, the strip flags that too, so
you can close the item. Anything else raises nothing: a mode that fell by half or more, or that
recurred fewer than three times beforehand, leaves too little to judge. Nothing is closed or moved
for you. Closing the item or setting another owner kind answers the flag, and it clears on the
next sweep. See [Waiting on you](./kanban.md#waiting-on-you) for the strip.

## Corrections

The **Corrections** tab lists the project's corrections over the last 7, 30 or 90 days, with the
kind of event that recorded each one and the failure mode a reviewer declared, if any. Narrow the
list by kind or mode, and open a correction's thread from its row.

## Prompts

The **Prompts** tab is the project's prompt library: prompts you send again and again, and
workflows, steps for an agent to follow in order. Search titles and bodies, or narrow the list by
state:

- **Active**: ready to use.
- **Proposed**: an agent or a learning item suggested it, and it waits for you to accept it.
- **Archived**: put away.

**New prompt** saves one, active at once. Open a prompt to accept it, archive it, or unarchive it.
Unarchiving brings back a prompt you had accepted as active, and one you never accepted as
proposed. Editing the title or body saves a new version; every earlier version stays listed, and
**Restore** saves a copy of one as the latest.

Agents reach the library through the `prompt_search`, `prompt_save` and `prompt_get` tools. An
agent has to search before it saves, so it finds a prompt that already covers the work, and what it
saves is proposed until you accept it.

## Reviews

With the review plugin on, the **Reviews** tab shows one thread's verdicts and review requests. See
[Policies and reviews](./policies-and-reviews.md#reviews) for how reviews work.
