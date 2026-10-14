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
- **Policy** and **Prompt**: a draft policy version on the **Policies** screen, keyed
  `learned-<failure mode>`, or `prompt-learned-<failure mode>` for a prompt. For now an accepted
  prompt policy reaches agents through the instruction files, like any other policy.

Each draft holds the item's reason and its latest five pieces of evidence. While the knowledge
plugin is off, items for project knowledge stay candidates; likewise policy items and prompt items
while the policy plugin is off. They are handed over once it is on again.

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

For a correction without a failure mode, other than a failed or interrupted turn, pick its mode
under **Declare mode** in its row; the next sweep adds it to that mode's item. A mode cannot be
changed once declared. Corrections left without a mode for seven days are flagged on the project's
board under [Waiting on you](./kanban.md#waiting-on-you), one row with the count, until each has a
mode.

## Reviews

With the review plugin on, the **Reviews** tab shows one thread's verdicts and review requests. See
[Policies and reviews](./policies-and-reviews.md#reviews) for how reviews work.
