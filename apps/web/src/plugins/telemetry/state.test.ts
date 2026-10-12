import type { SupervisorStatus, SupervisorSweepSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { lastHeartbeat } from "./state";

const sweep = (plugin: string, name: string): SupervisorSweepSummary => ({
  plugin,
  name,
  status: "ok",
  examined: 0,
  acted: 0,
  flags: 0,
  durationMs: 0,
  error: null,
});

const status = (sweeps: ReadonlyArray<SupervisorSweepSummary> | null): SupervisorStatus => ({
  intervalSeconds: 60,
  dryRun: false,
  sweeps: [],
  latest:
    sweeps === null
      ? null
      : {
          id: 1,
          startedAt: "2026-10-12T00:00:00.000Z",
          finishedAt: "2026-10-12T00:00:01.000Z",
          dryRun: false,
          sweeps,
        },
});

describe("lastHeartbeat", () => {
  it("is the latest tick's finish time only when that tick ran the heartbeat", () => {
    expect(lastHeartbeat(null)).toBeNull();
    expect(lastHeartbeat(status(null))).toBeNull();
    expect(lastHeartbeat(status([sweep("kanban", "archive")]))).toBeNull();
    expect(
      lastHeartbeat(status([sweep("kanban", "archive"), sweep("telemetry", "heartbeat")])),
    ).toBe("2026-10-12T00:00:01.000Z");
  });
});
