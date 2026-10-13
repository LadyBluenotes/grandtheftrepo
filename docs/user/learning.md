# Learning

The learning plugin keeps track of work that went wrong: a turn that failed or was interrupted, a
review that asked for changes, a ticket reopened after it was done. Each of these is a correction.
When the same failure mode recurs in a project, its corrections open a learning item, and the plugin
hands the item to whoever should act on it: the project's knowledge files, a prompt, or a policy.

While the plugin runs, **Learning** in the sidebar opens its screen. Turn it on under **Plugins**.
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

## Corrections

The **Corrections** tab lists the project's corrections over the last 7, 30 or 90 days, with the
kind of event that recorded each one and the failure mode a reviewer declared, if any. Narrow the
list by kind or mode, and open a correction's thread from its row.

## Reviews

With the review plugin on, the **Reviews** tab shows one thread's verdicts and review requests. See
[Policies and reviews](./policies-and-reviews.md#reviews) for how reviews work.
