import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, LearningItemDetail, LearningReviewVerdict } from "@t3tools/contracts";
import { CheckIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { cn } from "~/lib/utils";
import { type ChainStep, actorLabel, promotionChain, useLearningPromotionActions } from "./state";
import { When } from "./When";

/**
 * The item's chain as steps, the current one marked, with what a person can do there: give a
 * verdict on a handover in review, unless a person proposed it, or roll back an adopted one.
 */
export function HandoverChain({
  environmentId,
  detail,
  onChanged,
}: {
  readonly environmentId: EnvironmentId;
  readonly detail: LearningItemDetail;
  readonly onChanged: () => void;
}) {
  const { promotion, steps } = promotionChain(detail);
  const actions = useLearningPromotionActions(environmentId);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const run = async (title: string, action: () => Promise<AtomCommandResult<unknown, unknown>>) => {
    setSaving(true);
    const result = await action();
    setSaving(false);
    if (result._tag === "Success") {
      setNote("");
      onChanged();
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: failure instanceof Error ? failure.message : String(failure),
      }),
    );
  };
  const review = (verdict: LearningReviewVerdict) => {
    if (promotion === null) return;
    void run("Could not record the review", () =>
      actions.review({
        promotionId: promotion.id,
        verdict,
        ...(note.trim() === "" ? {} : { note: note.trim() }),
      }),
    );
  };

  // Every client is `user`, so a person cannot review a handover a person proposed.
  const ownProposal = promotion?.proposedBy === "user";
  // Closed or moved to another owner kind, the item no longer waits for this handover.
  const waiting =
    detail.item.state === "candidate" && detail.item.ownerKind === promotion?.ownerKind;
  const locked = !actions.canWrite || saving;

  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col gap-2.5" aria-label="Handover progress">
        {steps.map((step, index) => (
          <Step key={step.id} step={step} number={index + 1} />
        ))}
      </ol>
      {promotion?.state === "in_review" ? (
        <div className="flex flex-col gap-2">
          {!waiting ? (
            <p className="text-xs text-muted-foreground">
              The item no longer waits for this handover. Reopen it with this owner kind to review
              it.
            </p>
          ) : ownProposal ? (
            <p className="text-xs text-muted-foreground">
              A person proposed this handover by setting the item's owner kind, so someone else
              reviews it: ask an agent to review it with <code>learning_promotion_review</code>.
            </p>
          ) : (
            <>
              <Textarea
                size="sm"
                value={note}
                maxLength={500}
                disabled={locked}
                placeholder="Why, for the record (optional)"
                aria-label="Review note"
                onChange={(event) => setNote(event.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={locked} onClick={() => review("adopt")}>
                  Adopt
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={locked}
                  onClick={() => review("revise")}
                >
                  Ask for a revision
                </Button>
                <Button
                  size="sm"
                  variant="destructive-outline"
                  disabled={locked}
                  onClick={() => review("reject")}
                >
                  Reject
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Read the draft it wrote first. Adopting starts the four weeks its outcome is judged
                on; rejecting reopens the item.
              </p>
            </>
          )}
        </div>
      ) : promotion?.state === "adopted" ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="destructive-outline"
            disabled={locked}
            onClick={() =>
              void run("Could not roll back the handover", () => actions.rollBack(promotion.id))
            }
          >
            Roll back
          </Button>
          <span className="text-xs text-muted-foreground">Rolling back reopens the item.</span>
        </div>
      ) : null}
    </div>
  );
}

function Step({ step, number }: { readonly step: ChainStep; readonly number: number }) {
  const done = step.state === "done";
  const current = step.state === "current";
  return (
    <li className="flex gap-2.5" aria-current={current ? "step" : undefined}>
      <span
        className={cn(
          "mt-px grid size-5 shrink-0 place-items-center rounded-full text-xs font-medium ring-1",
          done
            ? "bg-primary text-primary-foreground ring-primary"
            : current
              ? "bg-primary/10 text-primary ring-primary/30"
              : "text-muted-foreground ring-border",
        )}
        aria-hidden
      >
        {done ? <CheckIcon className="size-3.5" /> : number}
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span
          className={cn(
            "text-sm",
            current
              ? "font-medium text-foreground"
              : done
                ? "text-foreground"
                : "text-muted-foreground",
          )}
        >
          {step.label}
          {current ? <span className="sr-only"> (current step)</span> : null}
        </span>
        {step.at === null && step.by === null ? null : (
          <span className="text-xs text-muted-foreground">
            {step.by === null ? null : `by ${actorLabel(step.by)} · `}
            <When at={step.at} />
          </span>
        )}
        {step.detail === null ? null : (
          <span className="whitespace-pre-wrap break-words text-xs">{step.detail}</span>
        )}
      </div>
    </li>
  );
}
