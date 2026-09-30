import type { AutomationSchedule } from "@t3tools/contracts";

export function reminderTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function buildReminderSchedule(input: {
  readonly kind: AutomationSchedule["kind"];
  readonly onceAt: string;
  readonly time: string;
  readonly weekday: number;
  readonly timezone: string;
  readonly now: number;
  readonly previousSchedule?: AutomationSchedule | undefined;
}): { schedule: AutomationSchedule | null; error: string | null } {
  if (input.kind === "once") {
    const parsed = Date.parse(input.onceAt);
    if (!Number.isFinite(parsed)) return { schedule: null, error: "Pick a valid date and time." };
    const unchanged =
      input.previousSchedule?.kind === "once" && Date.parse(input.previousSchedule.at) === parsed;
    if (!unchanged && parsed <= input.now) {
      return { schedule: null, error: "Choose a time in the future." };
    }
    return { schedule: { kind: "once", at: new Date(parsed).toISOString() }, error: null };
  }
  const timezone = input.timezone.trim();
  try {
    if (timezone.length === 0) throw new Error("missing timezone");
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
  } catch {
    return { schedule: null, error: "Choose a valid timezone, such as Asia/Kolkata." };
  }
  if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(input.time)) {
    return { schedule: null, error: "Pick a valid time." };
  }
  if (input.kind === "daily") {
    return { schedule: { kind: "daily", time: input.time, timezone }, error: null };
  }
  if (!Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 6) {
    return { schedule: null, error: "Pick a day of the week." };
  }
  return {
    schedule: { kind: "weekly", time: input.time, weekday: input.weekday, timezone },
    error: null,
  };
}

export function describeReminderSchedule(schedule: AutomationSchedule): string {
  if (schedule.kind === "once") {
    const date = new Date(schedule.at);
    return Number.isNaN(date.getTime())
      ? "Once"
      : `Once · ${date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
  }
  const day =
    schedule.kind === "daily"
      ? "Daily"
      : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][schedule.weekday];
  return `${day} · ${schedule.time} · ${schedule.timezone.replaceAll("_", " ")}`;
}
