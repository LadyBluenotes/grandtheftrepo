# Learning

The learning plugin keeps track of work that went wrong: a turn that failed or was interrupted, a
review that asked for changes, a security finding, a ticket reopened after it was done. Each of these
is a correction. When the same failure mode recurs in a project, its corrections open a learning
item, and the plugin hands the item to whoever should act on it: the project's knowledge files, a
prompt, or a policy.

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
- **Policy** and **Prompt**: a draft policy version on the **Policies** screen, keyed
  `learned-<failure mode>`, or `prompt-learned-<failure mode>` for a prompt. For now an accepted
  prompt policy reaches agents through the instruction files, like any other policy.

Each draft holds the item's reason and its latest five pieces of evidence. While the knowledge
plugin is off, items for project knowledge stay candidates; likewise policy items and prompt items
while the policy plugin is off. They are handed over once it is on again.

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
kind of event that recorded each one and its failure mode, if it has one. Narrow the list by kind
or mode, and open a correction's thread from its row.

## Reviews

With the review plugin on, the **Reviews** tab shows one thread's verdicts and review requests. See
[Policies and reviews](./policies-and-reviews.md#reviews) for how reviews work.
