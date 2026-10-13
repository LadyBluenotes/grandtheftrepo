import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  LearningItemDetail,
  LearningItemsSetDispositionInput,
} from "@t3tools/contracts";
import { useState, type ReactNode } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "~/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import {
  ITEM_STATE_LABEL,
  ITEM_STATE_VARIANT,
  OWNER_KIND_LABEL,
  OWNER_KINDS,
  PROMOTION_STATE_LABEL,
  PROMOTION_STATE_VARIANT,
  failureModeLabel,
  isOwnerKind,
  newestFirst,
  useLearningItem,
  useLearningSetDisposition,
} from "./state";
import { When } from "./When";

interface ItemDrawerProps {
  readonly environmentId: EnvironmentId;
  readonly itemId: number | null;
  readonly onClose: () => void;
  /** Runs after a disposition lands, so the list behind the drawer refetches. */
  readonly onChanged: () => void;
}

/** One item's evidence and promotions, and the disposition a person sets on it. */
export function ItemDrawer({ environmentId, itemId, onClose, onChanged }: ItemDrawerProps) {
  const detail = useLearningItem(environmentId, itemId);
  return (
    <Sheet open={itemId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetPopup side="right" className="sm:max-w-lg">
        {detail.data === null ? (
          <SheetHeader>
            <SheetTitle>{detail.error ?? "Loading…"}</SheetTitle>
          </SheetHeader>
        ) : (
          <ItemDetails
            key={detail.data.item.id}
            environmentId={environmentId}
            detail={detail.data}
            onChanged={() => {
              detail.refresh();
              onChanged();
            }}
          />
        )}
      </SheetPopup>
    </Sheet>
  );
}

function ItemDetails({
  environmentId,
  detail: { item, evidence, promotions },
  onChanged,
}: {
  readonly environmentId: EnvironmentId;
  readonly detail: LearningItemDetail;
  readonly onChanged: () => void;
}) {
  const { canWrite, set } = useLearningSetDisposition(environmentId);
  const [saving, setSaving] = useState(false);
  const locked = !canWrite || saving;

  const apply = async (input: Omit<LearningItemsSetDispositionInput, "id">) => {
    setSaving(true);
    const result = await set({ id: item.id, ...input });
    setSaving(false);
    if (result._tag === "Success") {
      onChanged();
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not set the disposition",
        description: failure instanceof Error ? failure.message : String(failure),
      }),
    );
  };

  return (
    <>
      <SheetHeader>
        <SheetTitle>{failureModeLabel(item.failureMode)}</SheetTitle>
        <SheetDescription>{item.reason}</SheetDescription>
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <Badge size="sm" variant={ITEM_STATE_VARIANT[item.state]}>
            {ITEM_STATE_LABEL[item.state]}
          </Badge>
          <span>{item.occurrences === 1 ? "1 occurrence" : `${item.occurrences} occurrences`}</span>
          <span>
            · set by {item.dispositionBy === "person" ? "a person" : "a rule"}
            {item.dispositionAt === null ? null : (
              <>
                {" "}
                <When at={item.dispositionAt} />
              </>
            )}
          </span>
          <span>
            · updated <When at={item.updatedAt} />
          </span>
        </div>
      </SheetHeader>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-5 px-6 pb-6">
          <Field label="Owner kind">
            <div className="flex flex-wrap items-center gap-2">
              <div className="w-48">
                <Select<string>
                  value={item.ownerKind ?? "none"}
                  disabled={locked}
                  onValueChange={(value) => {
                    const next = isOwnerKind(value) ? value : null;
                    if (next !== item.ownerKind) void apply({ ownerKind: next });
                  }}
                >
                  <SelectTrigger size="sm" aria-label="Owner kind">
                    <SelectValue>
                      {item.ownerKind === null ? "Unassigned" : OWNER_KIND_LABEL[item.ownerKind]}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="none">Unassigned</SelectItem>
                    {OWNER_KINDS.map((kind) => (
                      <SelectItem key={kind} value={kind}>
                        {OWNER_KIND_LABEL[kind]}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              {item.state === "closed" ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={locked}
                  onClick={() => void apply({ state: "open" })}
                >
                  Reopen
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={locked}
                  onClick={() => void apply({ state: "closed" })}
                >
                  Close item
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Candidate and promoted are not yours to set: the owner kind makes an open item a
              candidate, and handing it over makes it promoted.
            </p>
          </Field>

          <Field label="Evidence">
            {evidence.length === 0 ? (
              <p className="text-sm text-muted-foreground">None recorded.</p>
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                {newestFirst(evidence, (entry) => entry.createdAt).map((entry) => (
                  <li key={entry.evidenceKey} className="flex flex-col gap-0.5">
                    <span className="whitespace-pre-wrap">{entry.summary}</span>
                    <span className="text-xs text-muted-foreground">
                      <When at={entry.createdAt} /> · <code>{entry.evidenceKey}</code>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Field>

          <Field label="Promotions">
            {promotions.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing handed over yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Owner kind</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead>Attempts</TableHead>
                    <TableHead>Last error</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {promotions.map((promotion) => (
                    <TableRow key={promotion.id}>
                      <TableCell>{OWNER_KIND_LABEL[promotion.ownerKind]}</TableCell>
                      <TableCell>
                        <Badge size="sm" variant={PROMOTION_STATE_VARIANT[promotion.state]}>
                          {PROMOTION_STATE_LABEL[promotion.state]}
                        </Badge>
                      </TableCell>
                      <TableCell>{promotion.attempts}</TableCell>
                      <TableCell>
                        {promotion.lastError === null ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <span className="block max-w-56 whitespace-normal break-words">
                            {promotion.lastError}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Field>
        </div>
      </ScrollArea>
    </>
  );
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
