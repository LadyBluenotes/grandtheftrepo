import { describe, expect, it } from "vite-plus/test";

import { snoozeWakeDelayMs } from "./useSnoozeWake";

const NOW_MS = Date.parse("2026-10-13T12:00:00.000Z");

describe("snoozeWakeDelayMs", () => {
  it("waits until just past the wake time", () => {
    expect(snoozeWakeDelayMs("2026-10-13T12:00:30.000Z", NOW_MS)).toBe(30_050);
  });

  it("fires almost at once for a wake time that has passed", () => {
    expect(snoozeWakeDelayMs("2026-10-13T11:00:00.000Z", NOW_MS)).toBe(50);
  });

  it("stops at what a timer can hold for a wake time further out", () => {
    expect(snoozeWakeDelayMs("2027-10-13T12:00:00.000Z", NOW_MS)).toBe(2_147_483_647);
  });

  it("sets no timer for a malformed wake time", () => {
    expect(snoozeWakeDelayMs("soon", NOW_MS)).toBeNull();
  });
});
