import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { CavemanLearnClass, CavemanLearnSink } from "@t3tools/contracts";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Schema from "effect/Schema";
import { useState } from "react";

import {
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "~/components/settings/settingsLayout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import {
  scanScopeLabel,
  sinkTokensLabel,
  useCavemanLearnPlan,
  useCavemanLearnRefresh,
} from "./state";

/** Most actionable first; load-bearing sinks are needed, so they come last and stay folded. */
const CLASS_GROUPS: ReadonlyArray<{
  readonly class: CavemanLearnClass;
  readonly title: string;
  readonly help: string;
  readonly variant: "success" | "info" | "secondary" | "outline";
}> = [
  {
    class: "reducible",
    title: "Reducible",
    help: "A mechanical fix exists. Start here.",
    variant: "success",
  },
  {
    class: "recurring_context",
    title: "Recurring context",
    help: "Text you paste again in session after session. Consider moving it into an instruction file.",
    variant: "info",
  },
  {
    class: "behavioral",
    title: "Behavioral",
    help: "A habit, not a setting. Caveman reports it and changes nothing.",
    variant: "secondary",
  },
  {
    class: "load_bearing",
    title: "Load-bearing",
    help: "Needed for the work. Caveman never suggests removing these.",
    variant: "outline",
  },
];

const formatEvidence = Schema.encodeSync(fromJsonStringPretty(Schema.JsonObject));

/** A window bound as a date when it parses as one, else as caveman wrote it. */
const formatDay = (value: string) => {
  const time = Date.parse(value);
  return Number.isNaN(time) ? value : new Date(time).toLocaleDateString();
};

/**
 * The newest `caveman learn` report: the Setup Score, what it scanned, and every sink grouped by
 * what a person can do about it. Refresh starts a scan; the next sweep tick imports its report.
 */
export function CavemanImprovements() {
  const learn = useCavemanLearnPlan();
  const { canWrite, refresh } = useCavemanLearnRefresh();
  const [starting, setStarting] = useState(false);
  useRelativeTimeTick(60_000);

  const start = async () => {
    setStarting(true);
    const result = await refresh();
    setStarting(false);
    learn.refresh();
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not start a scan",
        description: failure instanceof Error ? failure.message : String(failure),
      }),
    );
  };

  const data = learn.data;
  const running = data?.scan.running ?? false;
  return (
    <>
      <SettingsSection title="Setup Score" hideTitle>
        <SettingsRow
          title={
            data?.state === "ready" ? `Setup Score: ${data.plan.caveScore} of 100` : "Setup Score"
          }
          description={
            data === null
              ? undefined
              : data.state === "ready"
                ? `${scanScopeLabel(data.plan.source)} Every number here is caveman's estimate.`
                : "No caveman learn report yet. Refresh scans this machine's session logs."
          }
          status={
            data === null
              ? (learn.error ?? "Loading")
              : running
                ? "A scan is running."
                : (data.scan.lastError ?? undefined)
          }
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={!canWrite || data === null || running || starting}
              onClick={() => void start()}
            >
              {running ? "Scanning" : "Refresh"}
            </Button>
          }
        />
        {data?.state === "ready" ? (
          <SettingsRow
            title="Last scan"
            description={`${data.plan.sessionsScanned} sessions, ${formatDay(data.plan.windowFrom)} to ${formatDay(data.plan.windowTo)}`}
            status={formatRelativeTimeLabel(data.plan.generatedAt)}
          />
        ) : null}
      </SettingsSection>
      {data?.state === "ready"
        ? CLASS_GROUPS.map((group) => {
            const sinks = data.sinks.filter((sink) => sink.class === group.class);
            if (sinks.length === 0) return null;
            return <ClassGroup key={group.class} group={group} sinks={sinks} />;
          })
        : null}
    </>
  );
}

function ClassGroup({
  group,
  sinks,
}: {
  readonly group: (typeof CLASS_GROUPS)[number];
  readonly sinks: ReadonlyArray<CavemanLearnSink>;
}) {
  const header = (
    <SettingsRow
      title={`${group.title} (${sinks.length})`}
      description={group.help}
      control={
        group.class === "load_bearing" ? (
          <CollapsibleTrigger render={<Button size="xs" variant="ghost" />}>
            Show
          </CollapsibleTrigger>
        ) : undefined
      }
    />
  );
  const rows = sinks.map((sink) => <SinkRow key={sink.rank} sink={sink} variant={group.variant} />);
  return (
    <SettingsSection title={group.title} hideTitle>
      {group.class === "load_bearing" ? (
        <Collapsible>
          {header}
          <CollapsiblePanel animate={false}>{rows}</CollapsiblePanel>
        </Collapsible>
      ) : (
        <>
          {header}
          {rows}
        </>
      )}
    </SettingsSection>
  );
}

function SinkRow({
  sink,
  variant,
}: {
  readonly sink: CavemanLearnSink;
  readonly variant: "success" | "info" | "secondary" | "outline";
}) {
  return (
    <Collapsible>
      <SettingsRow
        title={sink.title}
        description={sink.suggestion}
        status={
          <span className="flex flex-wrap items-center gap-2">
            <Badge size="sm" variant={variant}>
              #{sink.rank}
            </Badge>
            {sinkTokensLabel(sink)}
          </span>
        }
        control={
          <CollapsibleTrigger render={<Button size="xs" variant="ghost" />}>
            Details
          </CollapsibleTrigger>
        }
      >
        <CollapsiblePanel animate={false}>
          <p className="mb-2 text-xs leading-normal text-muted-foreground">{sink.basis}</p>
          <pre className="mb-2 max-h-64 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-xs break-all whitespace-pre-wrap text-muted-foreground">
            {formatEvidence(sink.evidence)}
          </pre>
        </CollapsiblePanel>
      </SettingsRow>
    </Collapsible>
  );
}
