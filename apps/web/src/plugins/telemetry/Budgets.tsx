import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { RoutingTier, TelemetryBudget, TelemetryBudgetPatch } from "@t3tools/contracts";
import { useState } from "react";

import { SettingsRow } from "~/components/settings/settingsLayout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "~/components/ui/number-field";
import { Switch } from "~/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useProjects } from "~/state/entities";
import { useTelemetryBudgetCommands, useTelemetryBudgets } from "./state";
import { usePluginEnvironmentId } from "../pluginState";

const TIER_LABEL: Record<RoutingTier, string> = {
  cheap: "Cheap",
  standard: "Standard",
  strong: "Strong",
};

const DIRECTION_LABEL: Record<TelemetryBudget["direction"], string> = {
  lower_is_better: "Lower is better",
  higher_is_better: "Higher is better",
};

/**
 * The environment's budgets, with their state, under the telemetry plugin's row. Threshold,
 * minimum sample and enabled save as they are committed; the sweep judges the change on its next
 * tick, so the state follows then. A save sends only the field it changes. A row takes no other
 * edit while its save is in flight, and no row does while the list rereads after one, so the
 * controls never show a value the server has already replaced.
 */
export function Budgets() {
  const environmentId = usePluginEnvironmentId();
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const budgets = useTelemetryBudgets();
  const { canWrite, save, remove } = useTelemetryBudgetCommands();
  const [saving, setSaving] = useState<ReadonlySet<number>>(() => new Set());
  const locked = (id: number) => !canWrite || saving.has(id) || budgets.isPending;

  const report = async (
    id: number,
    title: string,
    run: () => ReturnType<typeof save> | ReturnType<typeof remove>,
  ) => {
    setSaving((current) => new Set(current).add(id));
    const result = await run();
    // The refresh starts before the row is released, so `isPending` holds it until it lands.
    if (result._tag === "Success") budgets.refresh();
    setSaving((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: failure instanceof Error ? failure.message : String(failure),
      }),
    );
  };
  const change = (id: number, patch: Omit<TelemetryBudgetPatch, "id">) =>
    void report(id, "Could not save the budget", () => save({ id, ...patch }));

  return (
    <SettingsRow
      title="Budgets"
      description="A limit on one measure for one routing tier, judged over the last seven whole UTC days in each project. A breach raises an attention flag."
    >
      {budgets.error !== null ? (
        <p className="pb-3 text-sm text-muted-foreground">{budgets.error}</p>
      ) : (
        <div className="pb-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Measure</TableHead>
                <TableHead>Tier</TableHead>
                <TableHead>Project</TableHead>
                <TableHead>Threshold</TableHead>
                <TableHead>Direction</TableHead>
                <TableHead>Min sample</TableHead>
                <TableHead>Enabled</TableHead>
                <TableHead>State</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(budgets.data ?? []).map((budget) => (
                <TableRow key={budget.id}>
                  <TableCell>{budget.measure}</TableCell>
                  <TableCell>{TIER_LABEL[budget.tier]}</TableCell>
                  <TableCell>
                    {budget.projectId === null
                      ? "All projects"
                      : (projects.find((project) => project.id === budget.projectId)?.title ??
                        budget.projectId)}
                  </TableCell>
                  <TableCell>
                    <div className="w-24">
                      <NumberField
                        size="sm"
                        value={budget.threshold}
                        disabled={locked(budget.id)}
                        onValueCommitted={(threshold) => {
                          if (threshold !== null && threshold !== budget.threshold) {
                            change(budget.id, { threshold });
                          }
                        }}
                      >
                        <NumberFieldGroup>
                          <NumberFieldInput aria-label={`${budget.measure} threshold`} />
                        </NumberFieldGroup>
                      </NumberField>
                    </div>
                  </TableCell>
                  <TableCell>{DIRECTION_LABEL[budget.direction]}</TableCell>
                  <TableCell>
                    <div className="w-20">
                      <NumberField
                        size="sm"
                        min={0}
                        step={1}
                        value={budget.minSample}
                        disabled={locked(budget.id)}
                        onValueCommitted={(minSample) => {
                          const next =
                            minSample === null ? null : Math.max(0, Math.round(minSample));
                          if (next !== null && next !== budget.minSample) {
                            change(budget.id, { minSample: next });
                          }
                        }}
                      >
                        <NumberFieldGroup>
                          <NumberFieldInput aria-label={`${budget.measure} minimum sample`} />
                        </NumberFieldGroup>
                      </NumberField>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Switch
                      size="sm"
                      aria-label={`Enable the ${budget.tier} ${budget.measure} budget`}
                      checked={budget.enabled}
                      disabled={locked(budget.id)}
                      onCheckedChange={(enabled) => change(budget.id, { enabled })}
                    />
                  </TableCell>
                  <TableCell>
                    {budget.state === "breach" ? (
                      <Badge size="sm" variant="error">
                        Breach
                      </Badge>
                    ) : (
                      <Badge size="sm" variant="outline">
                        OK
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Button
                      size="xs"
                      variant="ghost-muted"
                      disabled={locked(budget.id)}
                      onClick={() =>
                        void report(budget.id, "Could not remove the budget", () =>
                          remove(budget.id),
                        )
                      }
                    >
                      Remove
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </SettingsRow>
  );
}
