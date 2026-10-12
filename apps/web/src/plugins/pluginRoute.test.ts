import type { PluginStatus } from "@t3tools/contracts";
import { PlugIcon } from "lucide-react";
import { lazy } from "react";
import { describe, expect, it } from "vite-plus/test";

import { pluginBadge, pluginScreenView, sidebarPlugins } from "./pluginRoute";
import type { PluginEntry } from "./registry";

const Screen = lazy(async () => ({ default: () => null }));
const registry: ReadonlyArray<PluginEntry> = [
  { id: "telemetry", title: "Telemetry", icon: PlugIcon, Screen },
  { id: "board", title: "Board", icon: PlugIcon },
];

const status = (patch: Partial<PluginStatus> = {}): PluginStatus => ({
  id: "telemetry",
  dependsOn: [],
  enabled: true,
  active: true,
  missing: [],
  startError: null,
  ...patch,
});

describe("pluginScreenView", () => {
  it("mounts the screen of a running plugin", () => {
    expect(pluginScreenView("telemetry", [status()], registry)).toEqual({ kind: "screen", Screen });
  });

  it("says so when the id is unknown, not running, or has no screen", () => {
    const statuses = [status(), status({ id: "board" }), status({ id: "off", active: false })];
    expect(pluginScreenView("ghost", statuses, registry)).toEqual({
      kind: "notice",
      message: 'No plugin named "ghost".',
      linkToPlugins: false,
    });
    expect(
      pluginScreenView("telemetry", [status({ active: false, enabled: false })], registry),
    ).toEqual({ kind: "notice", message: "Telemetry is not running.", linkToPlugins: true });
    expect(pluginScreenView("off", statuses, registry)).toEqual({
      kind: "notice",
      message: "off is not running.",
      linkToPlugins: true,
    });
    expect(pluginScreenView("board", statuses, registry)).toEqual({
      kind: "notice",
      message: "Board has no screen.",
      linkToPlugins: false,
    });
  });
});

describe("pluginBadge", () => {
  it("shows what runs and what a restart would change", () => {
    expect(pluginBadge(status()).label).toBe("Running");
    expect(pluginBadge(status({ enabled: false, active: false })).label).toBe("Off");
    expect(pluginBadge(status({ enabled: true, active: false })).label).toBe("Restart to apply");
    expect(pluginBadge(status({ enabled: false, active: true })).label).toBe("Restart to apply");
  });

  it("names the dependencies that keep a plugin off", () => {
    expect(
      pluginBadge(status({ enabled: true, active: false, missing: ["telemetry", "review"] })).label,
    ).toBe("Needs telemetry, review");
  });

  it("shows the start error instead of asking for a restart", () => {
    const failed = status({ enabled: true, active: false, startError: "Migration 2 failed." });
    expect(pluginBadge(failed)).toEqual({ label: "Migration 2 failed.", variant: "error" });
  });
});

describe("sidebarPlugins", () => {
  it("lists only running plugins that have a screen", () => {
    const statuses = [status(), status({ id: "board" })];
    expect(sidebarPlugins(statuses, registry).map((entry) => entry.id)).toEqual(["telemetry"]);
    expect(sidebarPlugins([status({ active: false })], registry)).toEqual([]);
    // Switched off but still running until a restart: the entry stays.
    expect(sidebarPlugins([status({ enabled: false })], registry)).toHaveLength(1);
  });
});
