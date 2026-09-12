import { describe, expect, it } from "vite-plus/test";
import type { AutomationSchedule } from "@t3tools/contracts";

import {
  computeNextFireAt,
  isValidAutomationTimezone,
  planFiring,
  validateAutomationSchedule,
} from "./AutomationSchedule.ts";

const daily = (time: string, timezone = "UTC"): AutomationSchedule => ({
  kind: "daily",
  time,
  timezone,
});

const weekly = (time: string, weekday: number, timezone = "UTC"): AutomationSchedule => ({
  kind: "weekly",
  time,
  weekday,
  timezone,
});

describe("AutomationSchedule", () => {
  it("validates timezones", () => {
    expect(isValidAutomationTimezone("America/New_York")).toBe(true);
    expect(isValidAutomationTimezone("UTC")).toBe(true);
    expect(isValidAutomationTimezone("Mars/Olympus")).toBe(false);
    expect(isValidAutomationTimezone("")).toBe(false);
  });

  it("fires a once schedule at its instant, then never again", () => {
    const schedule: AutomationSchedule = { kind: "once", at: "2026-09-20T09:00:00.000Z" };
    expect(validateAutomationSchedule({ schedule, nowIso: "2026-09-19T00:00:00.000Z" })).toBe(null);
    expect(computeNextFireAt(schedule, "2026-09-19T00:00:00.000Z")).toBe(
      "2026-09-20T09:00:00.000Z",
    );
    expect(computeNextFireAt(schedule, "2026-09-20T09:00:00.000Z")).toBe(null);
    expect(computeNextFireAt(schedule, "2026-09-21T00:00:00.000Z")).toBe(null);
  });

  it("rejects a once schedule that is not in the future", () => {
    const schedule: AutomationSchedule = { kind: "once", at: "2026-09-20T09:00:00.000Z" };
    expect(validateAutomationSchedule({ schedule, nowIso: "2026-09-20T09:00:00.000Z" })).toContain(
      "not in the future",
    );
    expect(validateAutomationSchedule({ schedule, nowIso: "not-a-date" })).toContain(
      "not in the future",
    );
  });

  it("rejects an unknown timezone", () => {
    expect(
      validateAutomationSchedule({
        schedule: daily("09:00", "Mars/Olympus"),
        nowIso: "2026-09-19T00:00:00.000Z",
      }),
    ).toContain("not a valid IANA timezone");
  });

  it("computes the next daily firing in wall-clock time", () => {
    // 09:00 America/New_York on 2026-09-18 (EDT, UTC-4) is 13:00Z.
    expect(computeNextFireAt(daily("09:00", "America/New_York"), "2026-09-18T12:00:00.000Z")).toBe(
      "2026-09-18T13:00:00.000Z",
    );
    // After today's slot, tomorrow's slot.
    expect(computeNextFireAt(daily("09:00", "America/New_York"), "2026-09-18T14:00:00.000Z")).toBe(
      "2026-09-19T13:00:00.000Z",
    );
  });

  it("keeps wall-clock time across the spring-forward gap", () => {
    // 2026-03-08: clocks jump 02:00 -> 03:00 in America/New_York, so 02:30
    // does not exist. The firing shifts to the next valid minute (03:00).
    expect(computeNextFireAt(daily("02:30", "America/New_York"), "2026-03-07T12:00:00.000Z")).toBe(
      "2026-03-08T07:00:00.000Z",
    );
  });

  it("fires an ambiguous fall-back wall time at its first occurrence", () => {
    // 2026-11-01: clocks fall back 02:00 -> 01:00 in America/New_York, so
    // 01:30 happens twice. The first occurrence is 01:30 EDT (05:30Z).
    expect(computeNextFireAt(daily("01:30", "America/New_York"), "2026-10-31T12:00:00.000Z")).toBe(
      "2026-11-01T05:30:00.000Z",
    );
  });

  it("computes the next weekly firing on the right weekday", () => {
    // 2026-09-18 is a Friday. Next Monday 09:00 UTC is 2026-09-21.
    expect(computeNextFireAt(weekly("09:00", 1), "2026-09-18T12:00:00.000Z")).toBe(
      "2026-09-21T09:00:00.000Z",
    );
    // Same weekday later that day, before the slot: today.
    expect(computeNextFireAt(weekly("23:00", 5), "2026-09-18T12:00:00.000Z")).toBe(
      "2026-09-18T23:00:00.000Z",
    );
    // Same weekday after the slot: next week.
    expect(computeNextFireAt(weekly("09:00", 5), "2026-09-18T12:00:00.000Z")).toBe(
      "2026-09-25T09:00:00.000Z",
    );
  });

  it("plans an on-time firing as ran", () => {
    const planned = planFiring({
      schedule: daily("09:00"),
      nextFireAt: "2026-09-18T09:00:00.000Z",
      nowIso: "2026-09-18T09:00:30.000Z",
    });
    expect(planned?.occurrenceKey).toBe("2026-09-18T09:00:00.000Z");
    expect(planned?.outcome).toBe("ran");
    expect(planned?.nextFireAt).toBe("2026-09-19T09:00:00.000Z");
  });

  it("plans a stale slot as missed-then-ran and skips to the next future slot", () => {
    // The server was off for three days: fire once for the stale slot and
    // jump straight to tomorrow. Missed days are never backfilled.
    const planned = planFiring({
      schedule: daily("09:00"),
      nextFireAt: "2026-09-15T09:00:00.000Z",
      nowIso: "2026-09-18T12:00:00.000Z",
    });
    expect(planned?.occurrenceKey).toBe("2026-09-15T09:00:00.000Z");
    expect(planned?.outcome).toBe("missed-then-ran");
    expect(planned?.nextFireAt).toBe("2026-09-19T09:00:00.000Z");
  });

  it("plans nothing when the row is not due", () => {
    expect(
      planFiring({
        schedule: daily("09:00"),
        nextFireAt: null,
        nowIso: "2026-09-18T12:00:00.000Z",
      }),
    ).toBe(null);
    expect(
      planFiring({
        schedule: daily("09:00"),
        nextFireAt: "2026-09-19T09:00:00.000Z",
        nowIso: "2026-09-18T12:00:00.000Z",
      }),
    ).toBe(null);
  });

  it("a fired once schedule has nothing next", () => {
    const planned = planFiring({
      schedule: { kind: "once", at: "2026-09-18T09:00:00.000Z" },
      nextFireAt: "2026-09-18T09:00:00.000Z",
      nowIso: "2026-09-18T09:00:10.000Z",
    });
    expect(planned?.outcome).toBe("ran");
    expect(planned?.nextFireAt).toBe(null);
  });
});
