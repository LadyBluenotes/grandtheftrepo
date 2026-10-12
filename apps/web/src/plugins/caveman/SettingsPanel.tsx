import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  CAVEMAN_INSTALL_COMMAND,
  type CavemanAgentRoute,
  type CavemanRoute,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { useState } from "react";

import { SettingsRow } from "~/components/settings/settingsLayout";
import { Badge } from "~/components/ui/badge";
import { Switch } from "~/components/ui/switch";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { primaryServerProvidersAtom } from "~/state/server";
import { useCavemanSetRoute, useCavemanStatus } from "./state";

const ROUTE_BADGE: Record<
  CavemanRoute,
  { readonly label: string; readonly variant: "success" | "secondary" | "warning" | "outline" }
> = {
  routed: { label: "Routed", variant: "success" },
  direct: { label: "Direct", variant: "secondary" },
  other: { label: "Other", variant: "warning" },
  unsupported: { label: "Unsupported", variant: "outline" },
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
    </>
  );
}
