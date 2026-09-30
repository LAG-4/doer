import { describe, expect, it } from "vite-plus/test";
import { buildReminderSchedule, describeReminderSchedule } from "./scheduledTaskForm";

const base = {
  kind: "once" as const,
  onceAt: "2026-09-29T09:00:00.000Z",
  time: "09:00",
  weekday: 1,
  timezone: "Asia/Kolkata",
  now: Date.parse("2026-09-30T09:00:00.000Z"),
};

describe("reminder editing", () => {
  it("allows changing the prompt of a paused or overdue one-off without rescheduling it", () => {
    expect(
      buildReminderSchedule({ ...base, previousSchedule: { kind: "once", at: base.onceAt } })
        .schedule,
    ).toEqual({ kind: "once", at: base.onceAt });
    expect(buildReminderSchedule(base).error).toBe("Choose a time in the future.");
    expect(
      buildReminderSchedule({
        ...base,
        onceAt: "2026-09-28T09:00:00.000Z",
        previousSchedule: { kind: "once", at: base.onceAt },
      }).error,
    ).toBe("Choose a time in the future.");
  });

  it("does not validate a hidden recurring timezone for a one-off", () => {
    const result = buildReminderSchedule({
      ...base,
      onceAt: "2026-10-01T09:00:00.000Z",
      timezone: "",
    });
    expect(result.error).toBeNull();
    expect(result.schedule).toEqual({ kind: "once", at: "2026-10-01T09:00:00.000Z" });
  });

  it("rejects invalid recurring timing before a task is created", () => {
    expect(
      buildReminderSchedule({ ...base, kind: "daily", timezone: "Invalid/Zone" }).schedule,
    ).toBeNull();
    expect(buildReminderSchedule({ ...base, kind: "daily", time: "25:00" }).schedule).toBeNull();
    expect(buildReminderSchedule({ ...base, kind: "weekly", weekday: 7 }).schedule).toBeNull();
    expect(buildReminderSchedule({ ...base, kind: "daily" }).schedule).toEqual({
      kind: "daily",
      time: "09:00",
      timezone: "Asia/Kolkata",
    });
  });

  it("labels recurring times with the timezone actually saved", () => {
    expect(
      describeReminderSchedule({ kind: "daily", time: "09:00", timezone: "Asia/Kolkata" }),
    ).toBe("Daily · 09:00 · Asia/Kolkata");
    expect(
      describeReminderSchedule({
        kind: "weekly",
        weekday: 1,
        time: "09:00",
        timezone: "America/New_York",
      }),
    ).toBe("Mon · 09:00 · America/New York");
  });
});
