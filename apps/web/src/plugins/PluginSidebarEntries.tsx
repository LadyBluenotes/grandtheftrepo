import { PlugIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";

import { SidebarUtilityItem } from "~/components/sidebar/SidebarChrome";
import { useSidebar } from "~/components/ui/sidebar";
import { sidebarPlugins } from "./pluginRoute";
import { usePluginStatuses } from "./pluginState";
import { pluginRegistry } from "./registry";

/** Sidebar buttons for the Plugins page and each running plugin that has a screen. */
export function PluginSidebarEntries() {
  const { statuses } = usePluginStatuses();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  if (statuses === null) return null;

  const go = (open: () => Promise<void>) => () => {
    if (isMobile) setOpenMobile(false);
    void open();
  };
  return (
    <>
      <SidebarUtilityItem
        icon={<PlugIcon />}
        label="Plugins"
        onClick={go(() => navigate({ to: "/plugins" }))}
      />
      {sidebarPlugins(statuses, pluginRegistry).map((entry) => (
        <SidebarUtilityItem
          key={entry.id}
          icon={<entry.icon />}
          label={entry.title}
          onClick={go(() => navigate({ to: "/plugins/$pluginId", params: { pluginId: entry.id } }))}
        />
      ))}
    </>
  );
}
