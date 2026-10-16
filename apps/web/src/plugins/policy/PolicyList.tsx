import type { PolicyListing } from "@t3tools/contracts";

import { useRelativeTimeTick } from "~/components/settings/settingsLayout";
import { Badge } from "~/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { pendingDraft, STATE_BADGE } from "./state";

/**
 * One row per policy of the scope: the version on show (the accepted one, else the latest
 * draft), its state, and a draft waiting above it. A row opens the policy below the list.
 */
export function PolicyList({
  policies,
  selectedKey,
  onSelect,
}: {
  readonly policies: ReadonlyArray<PolicyListing>;
  readonly selectedKey: string | null;
  readonly onSelect: (key: string) => void;
}) {
  useRelativeTimeTick(60_000);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Key</TableHead>
          <TableHead>Title</TableHead>
          <TableHead>Version</TableHead>
          <TableHead>Updated</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {policies.map((policy) => {
          const state = STATE_BADGE[policy.state];
          const draft = pendingDraft(policy);
          return (
            <TableRow
              key={policy.key}
              className="cursor-pointer"
              data-state={policy.key === selectedKey ? "selected" : undefined}
              onClick={() => onSelect(policy.key)}
            >
              <TableCell>
                {/* The row takes the click; the button gives the keyboard a stop, and its click bubbles up. */}
                <button
                  type="button"
                  className="font-mono text-left outline-none focus-visible:underline"
                  aria-pressed={policy.key === selectedKey}
                >
                  {policy.key}
                </button>
              </TableCell>
              <TableCell>
                <span className="block max-w-64 truncate">{policy.title}</span>
              </TableCell>
              <TableCell>
                <span className="inline-flex items-center gap-1.5">
                  v{policy.version}
                  <Badge size="sm" variant={state.variant}>
                    {state.label}
                  </Badge>
                  {draft === null ? null : (
                    <Badge size="sm" variant="warning">
                      Draft v{draft.version}
                    </Badge>
                  )}
                </span>
              </TableCell>
              <TableCell>
                <span className="text-muted-foreground">
                  {formatRelativeTimeLabel(policy.updatedAt)}
                </span>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
