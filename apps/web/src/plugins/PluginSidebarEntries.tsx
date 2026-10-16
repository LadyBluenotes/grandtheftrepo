import { PlugIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";

import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "~/components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { sidebarPlugins } from "./pluginRoute";
import { usePluginStatuses } from "./pluginState";
import { pluginRegistry } from "./registry";

/**
 * One sidebar button for everything plugins add: a menu with the Plugins page and each running
 * plugin that has a screen. One button, however many plugins run, so the utility row never wraps
 * or spills past the sidebar's bottom edge.
 */
export function PluginSidebarEntries() {
  const { statuses } = usePluginStatuses();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  if (statuses === null) return null;

  const go = (open: () => Promise<void>) => () => {
    if (isMobile) setOpenMobile(false);
    void open();
  };
  const screens = sidebarPlugins(statuses, pluginRegistry);
  return (
    <SidebarMenuItem className="shrink-0">
      <Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger render={<SidebarMenuButton aria-label="Plugins" size="icon" />}>
                <PlugIcon />
              </MenuTrigger>
            }
          />
          <TooltipPopup side="top">Plugins</TooltipPopup>
        </Tooltip>
        <MenuPopup side="top" align="end">
          <MenuItem onClick={go(() => navigate({ to: "/plugins" }))}>
            <PlugIcon />
            Plugins
          </MenuItem>
          {screens.length === 0 ? null : <MenuSeparator />}
          {screens.map((entry) => (
            <MenuItem
              key={entry.id}
              onClick={go(() =>
                navigate({ to: "/plugins/$pluginId", params: { pluginId: entry.id } }),
              )}
            >
              <entry.icon />
              {entry.title}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    </SidebarMenuItem>
  );
}
