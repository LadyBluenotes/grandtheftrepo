import type { PolicyListing, ProjectId } from "@t3tools/contracts";
import { useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { reportFailure } from "./PolicyEditor";
import { AGENT_LABEL, canInstall, DELIVERY_BADGE, usePolicyCommands } from "./state";

/**
 * Each agent's instruction file against the policy's accepted version, as the list re-read it:
 * `ok`, `outdated` when the block is intact but is another version than the accepted one,
 * `drifted` when the block was edited, `missing` when the file or block is gone or nothing was
 * installed into the file the agent reads now. Reinstall, offered whatever the status while a version is accepted, writes the
 * accepted version to every agent whose directory exists, then the list re-reads.
 */
export function DeliveryStatus({
  scope,
  policy,
  onChanged,
}: {
  readonly scope: ProjectId;
  readonly policy: PolicyListing;
  readonly onChanged: () => void;
}) {
  const { canWrite, install } = usePolicyCommands();
  const [installing, setInstalling] = useState(false);

  const reinstall = async () => {
    setInstalling(true);
    const result = await install({ projectId: scope, key: policy.key });
    setInstalling(false);
    reportFailure("Could not reinstall the policy", result);
    // Install writes agent by agent, so a failed one may have written some; re-read either way.
    onChanged();
    if (result._tag !== "Success") return;
    const skipped = result.value.filter((agent) => agent.status === "skipped");
    if (skipped.length > 0) {
      toastManager.add(
        stackedThreadToast({
          type: "info",
          title: "Some agents were skipped",
          description: `${skipped.map((agent) => AGENT_LABEL[agent.agent]).join(", ")}: the directory does not exist, so nothing was written.`,
        }),
      );
    }
  };

  return (
    <section className="flex flex-col gap-2" aria-label="Delivery">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">Delivery</h3>
        <Button
          className="ml-auto"
          size="xs"
          variant="outline"
          disabled={!canWrite || installing || !canInstall(policy)}
          onClick={() => void reinstall()}
        >
          Reinstall
        </Button>
      </div>
      {canInstall(policy) ? null : (
        <p className="text-xs text-muted-foreground">
          Nothing is delivered until a version is accepted.
        </p>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Agent</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>File</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {policy.status.map((agent) => {
            const badge = DELIVERY_BADGE[agent.status];
            return (
              <TableRow key={agent.agent}>
                <TableCell>{AGENT_LABEL[agent.agent]}</TableCell>
                <TableCell>
                  <span className="inline-flex items-center gap-1.5">
                    <Badge size="sm" variant={badge.variant}>
                      {badge.label}
                    </Badge>
                    {agent.status === "ok" && !agent.rulesCurrent ? (
                      <Badge size="sm" variant="outline">
                        Older rules
                      </Badge>
                    ) : null}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="block max-w-96 truncate font-mono text-muted-foreground">
                    {agent.path}
                  </span>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </section>
  );
}
