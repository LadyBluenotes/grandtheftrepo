import type { PluginStatus } from "@t3tools/contracts";

import { SettingsRow, useRelativeTimeTick } from "~/components/settings/settingsLayout";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { lastHeartbeat, useSupervisorStatus } from "./state";

/** Under the plugin's row on the Plugins page: what the host says about it, and when its sweep last ran. */
export function TelemetrySettingsPanel({ status }: { readonly status: PluginStatus }) {
  const finishedAt = lastHeartbeat(useSupervisorStatus());
  useRelativeTimeTick();
  return (
    <>
      <SettingsRow title="Enabled" status={status.enabled ? "Yes" : "No"} />
      <SettingsRow title="Running" status={status.active ? "Yes" : "No"} />
      <SettingsRow
        title="Last tick"
        status={finishedAt === null ? "No tick yet" : formatRelativeTimeLabel(finishedAt)}
      />
    </>
  );
}
