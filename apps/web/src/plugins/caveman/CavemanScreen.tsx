import { ShrinkIcon } from "lucide-react";

import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { PluginDetailShell, type PluginDetailTab } from "../PluginDetailShell";
import { usePluginScreenSearch } from "../pluginScreenSearch";
import { CavemanImprovements } from "./CavemanImprovements";
import { CavemanSettings } from "./CavemanSettings";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "settings", label: "Settings" },
  { id: "improvements", label: "Improvements" },
] as const satisfies ReadonlyArray<PluginDetailTab<string>>;

/** `/plugins/caveman`: what it is, how it routes your agents, and where tokens go. */
export function CavemanScreen() {
  const search = usePluginScreenSearch();
  const tab = TABS.find((candidate) => candidate.id === search.tab)?.id ?? "overview";
  return (
    <PluginDetailShell
      title="Caveman"
      icon={ShrinkIcon}
      tabs={TABS}
      tab={tab}
      onTabChange={search.setTab}
    >
      {tab === "overview" ? (
        <CavemanOverview />
      ) : tab === "settings" ? (
        <SettingsSection title="Routing" hideTitle>
          <CavemanSettings />
        </SettingsSection>
      ) : (
        <CavemanImprovements />
      )}
    </PluginDetailShell>
  );
}

function CavemanOverview() {
  return (
    <SettingsSection title="About Caveman" hideTitle>
      <SettingsRow
        title="What it does"
        description="Caveman runs a local proxy for your agent traffic and scans your session logs for places tokens go."
      />
      <SettingsRow
        title="Settings"
        description="Choose, per Claude Code or Codex instance, whether its requests go through caveman's proxy."
      />
      <SettingsRow
        title="Improvements"
        description="The newest caveman learn report: a Setup Score out of 100 and the biggest token sinks, grouped by what you can do about each. Scans read this machine's session logs; every number is an estimate."
      />
      <SettingsRow
        title="What it changes"
        description="Routing edits your own Claude Code and Codex settings, so terminal sessions outside T3 Code are routed too. Claude Code's Remote Control will not start while it is routed."
      />
    </SettingsSection>
  );
}
