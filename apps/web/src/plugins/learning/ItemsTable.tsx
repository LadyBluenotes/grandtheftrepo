import type { LearningItemState } from "@t3tools/contracts";
import { useMemo, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { InlineButton } from "~/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { ItemDrawer } from "./ItemDrawer";
import {
  ITEM_STATE_LABEL,
  ITEM_STATE_VARIANT,
  ITEM_STATES,
  OWNER_KIND_LABEL,
  failureModeLabel,
  isItemState,
  itemRows,
  useLearningItems,
  type LearningScope,
} from "./state";
import { When } from "./When";

/**
 * A project's items, the most recently updated first, narrowed to one state. A row's failure mode
 * opens the drawer, and a disposition set there refetches the list.
 */
export function ItemsTable({ environmentId, projectId }: LearningScope) {
  const [state, setState] = useState<LearningItemState | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const items = useLearningItems({ environmentId, projectId });
  const rows = useMemo(() => itemRows(items.data ?? [], state), [items.data, state]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-40">
          <Select<string>
            value={state ?? "all"}
            onValueChange={(value) => setState(isItemState(value) ? value : null)}
          >
            <SelectTrigger size="sm" aria-label="State">
              <SelectValue>{state === null ? "All states" : ITEM_STATE_LABEL[state]}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="all">All states</SelectItem>
              {ITEM_STATES.map((candidate) => (
                <SelectItem key={candidate} value={candidate}>
                  {ITEM_STATE_LABEL[candidate]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <span className="text-xs text-muted-foreground">
          {rows.length === 1 ? "1 item" : `${rows.length} items`}
        </span>
      </div>
      {items.error !== null ? (
        <p className="text-sm text-muted-foreground">{items.error}</p>
      ) : items.data !== null && rows.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No items</EmptyTitle>
            <EmptyDescription>
              {state === null
                ? "A failure mode that recurs in this project opens an item here."
                : `No ${ITEM_STATE_LABEL[state].toLowerCase()} items.`}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Failure mode</TableHead>
              <TableHead>Occurrences</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Set by</TableHead>
              <TableHead>Set</TableHead>
              <TableHead>Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <InlineButton onClick={() => setOpenId(row.id)}>
                    {failureModeLabel(row.failureMode)}
                  </InlineButton>
                </TableCell>
                <TableCell>{row.occurrences}</TableCell>
                <TableCell>
                  <Badge size="sm" variant={ITEM_STATE_VARIANT[row.state]}>
                    {ITEM_STATE_LABEL[row.state]}
                  </Badge>
                </TableCell>
                <TableCell>
                  {row.ownerKind === null ? (
                    <span className="text-muted-foreground">Unassigned</span>
                  ) : (
                    OWNER_KIND_LABEL[row.ownerKind]
                  )}
                </TableCell>
                <TableCell>{row.setBy === "person" ? "Person" : "Rule"}</TableCell>
                <TableCell>
                  <When at={row.setAt} />
                </TableCell>
                <TableCell>
                  <When at={row.updatedAt} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <ItemDrawer
        environmentId={environmentId}
        itemId={openId}
        onClose={() => setOpenId(null)}
        onChanged={items.refresh}
      />
    </div>
  );
}
