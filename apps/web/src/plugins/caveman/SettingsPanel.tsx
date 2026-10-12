import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  CAVEMAN_INSTALL_COMMAND,
  type CavemanAgentRoute,
  type CavemanLearnClass,
  type CavemanLearnSink,
  type CavemanRoute,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { SettingsRow, useRelativeTimeTick } from "~/components/settings/settingsLayout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { Switch } from "~/components/ui/switch";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { primaryServerProvidersAtom } from "~/state/server";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import {
  scanScopeLabel,
  sinkTokensLabel,
  useCavemanLearnPlan,
  useCavemanLearnRefresh,
  useCavemanSetRoute,
  useCavemanStatus,
} from "./state";

const ROUTE_BADGE: Record<
  CavemanRoute,
  { readonly label: string; readonly variant: "success" | "secondary" | "warning" | "outline" }
> = {
  routed: { label: "Routed", variant: "success" },
  direct: { label: "Direct", variant: "secondary" },
  other: { label: "Other", variant: "warning" },
  unsupported: { label: "Unsupported", variant: "outline" },
};

const CLASS_BADGE: Record<
  CavemanLearnClass,
  { readonly label: string; readonly variant: "success" | "info" | "secondary" | "outline" }
> = {
  reducible: { label: "Reducible", variant: "success" },
  recurring_context: { label: "Recurring context", variant: "info" },
  behavioral: { label: "Behavioral", variant: "secondary" },
  load_bearing: { label: "Load-bearing", variant: "outline" },
};

/** The panel shows the top sinks; the rest stay in the plan. */
const TOP_SINKS = 5;

const formatEvidence = Schema.encodeSync(fromJsonStringPretty(Schema.JsonObject));

/** A window bound as a date when it parses as one, else as caveman wrote it. */
const formatDay = (value: string) => {
  const time = Date.parse(value);
  return Number.isNaN(time) ? value : new Date(time).toLocaleDateString();
};

/** Only these agents have a caveman command that switches them. */
const switchable = (row: CavemanAgentRoute) =>
  (row.agent === "claude" || row.agent === "codex") && row.route !== "unsupported";

/**
 * Under the plugin's row on the Plugins page: whether caveman's proxy is up, and per provider
 * instance whether its traffic goes through it, with a switch for Claude and Codex instances.
 */
export function SettingsPanel() {
  const status = useCavemanStatus();
  const { canWrite, set } = useCavemanSetRoute();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const [switching, setSwitching] = useState<ProviderInstanceId | null>(null);

  const toggle = async (instanceId: ProviderInstanceId, enabled: boolean) => {
    setSwitching(instanceId);
    const result = await set({ instanceId, enabled });
    setSwitching(null);
    if (result._tag === "Success") {
      status.refresh();
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not switch the route",
        description: failure instanceof Error ? failure.message : String(failure),
      }),
    );
  };

  if (status.data === null) {
    return <SettingsRow title="Status" status={status.error ?? "Loading"} />;
  }
  const { installed, version, proxy, agents } = status.data;

  return (
    <>
      <SettingsRow
        title="Proxy"
        description={installed ? `caveman ${version ?? ""}`.trim() : undefined}
        status={
          proxy.listening === null
            ? proxy.origin
            : `${proxy.origin}, ${proxy.listening ? "listening" : "not listening"}`
        }
      />
      {installed ? null : (
        <SettingsRow
          title="Install caveman"
          description={`Run ${CAVEMAN_INSTALL_COMMAND}, then reload this page.`}
        />
      )}
      {agents.map((row) => {
        const badge = ROUTE_BADGE[row.route];
        const name =
          providers.find((candidate) => candidate.instanceId === row.instanceId)?.displayName ??
          row.instanceId;
        return (
          <SettingsRow
            key={row.instanceId}
            title={name}
            description={row.detail ?? undefined}
            status={
              <Badge size="sm" variant={badge.variant}>
                {badge.label}
              </Badge>
            }
            control={
              installed && switchable(row) ? (
                <Switch
                  aria-label={`Route ${name} through caveman`}
                  checked={row.route === "routed"}
                  disabled={!canWrite || switching !== null}
                  onCheckedChange={(enabled) => void toggle(row.instanceId, enabled)}
                />
              ) : undefined
            }
          />
        );
      })}
      <p className="px-3 pt-1 pb-3 text-xs leading-normal text-muted-foreground/80 sm:px-4">
        The switch changes your own Claude Code and Codex settings, so terminal sessions are routed
        too. Claude Code's Remote Control will not start while it is routed.
      </p>
      <WhereTokensGo />
    </>
  );
}

/**
 * The newest `caveman learn` report: the Setup Score, what it scanned, and the top sinks with
 * their evidence behind Details. Refresh starts a scan; the next sweep tick imports its report.
 */
function WhereTokensGo() {
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
      <SettingsRow
        title="Where tokens go"
        description={
          data === null
            ? undefined
            : data.state === "ready"
              ? scanScopeLabel(data.plan.source)
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
        <>
          <SettingsRow title="Setup Score" status={`${data.plan.caveScore} of 100, estimate`} />
          <SettingsRow title="Sessions scanned" status={`${data.plan.sessionsScanned}, estimate`} />
          <SettingsRow
            title="Window"
            status={`${formatDay(data.plan.windowFrom)} to ${formatDay(data.plan.windowTo)}`}
          />
          <SettingsRow title="Last scan" status={formatRelativeTimeLabel(data.plan.generatedAt)} />
          {data.sinks.slice(0, TOP_SINKS).map((sink) => (
            <SinkRow key={sink.rank} sink={sink} />
          ))}
        </>
      ) : null}
    </>
  );
}

function SinkRow({ sink }: { readonly sink: CavemanLearnSink }) {
  const badge = CLASS_BADGE[sink.class];
  return (
    <Collapsible>
      <SettingsRow
        title={sink.title}
        description={sink.suggestion}
        status={
          <span className="flex flex-wrap items-center gap-2">
            <Badge size="sm" variant={badge.variant}>
              {badge.label}
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
          <pre className="mb-2 max-h-64 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-xs break-all whitespace-pre-wrap text-muted-foreground">
            {formatEvidence(sink.evidence)}
          </pre>
        </CollapsiblePanel>
      </SettingsRow>
    </Collapsible>
  );
}
