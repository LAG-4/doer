// @effect-diagnostics globalDate:off
/**
 * Pure wall-clock schedule math for automations ("Scheduled tasks").
 *
 * `Intl.DateTimeFormat` is the only reliable way to resolve wall-clock time
 * in an arbitrary IANA zone, and it takes a `Date`. That is why the raw
 * `Date` construction is allowed here; nothing in this module reads the
 * clock.
 *
 * Daily and weekly automations fire in the owner's local wall-clock time
 * (an IANA timezone stored on the schedule), so a 09:00 automation stays at
 * 09:00 across daylight-saving transitions. The algorithm resolves a
 * (local date, wall-clock time) pair to an instant by scanning minute
 * candidates around the nominal time: a gap (spring forward) shifts to the
 * next valid minute, an ambiguous hour (fall back) fires at its first
 * occurrence. The approach mirrors the reference implementation in
 * `different-ai/openwork` (`packages/automations/src/schedule.ts`), adapted
 * here to ISO strings and the Effect codebase conventions.
 *
 * This module is pure: no clocks, no I/O. The decider and the scheduler
 * reactor share it, and unit tests pin the DST behavior.
 */

import type { AutomationRunOutcome, AutomationSchedule } from "@t3tools/contracts";

const MINUTE_MS = 60_000;
const SEARCH_WINDOW_MS = 18 * 60 * MINUTE_MS;
const MISSED_THRESHOLD_MS = 60_000;

interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

interface LocalDateTime extends LocalDate {
  readonly hour: number;
  readonly minute: number;
  readonly weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const existing = formatters.get(timezone);
  if (existing !== undefined) return existing;
  const created = new Intl.DateTimeFormat("en-US-u-ca-gregory", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
  formatters.set(timezone, created);
  return created;
}

/** Whether the timezone is a valid IANA name. */
export function isValidAutomationTimezone(timezone: string): boolean {
  try {
    formatterFor(timezone).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function localDateTime(timestampMs: number, timezone: string): LocalDateTime {
  const values = new Map(
    formatterFor(timezone)
      .formatToParts(new Date(timestampMs))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
    values.get("weekday") ?? "",
  );
  return {
    year: Number(values.get("year")),
    month: Number(values.get("month")),
    day: Number(values.get("day")),
    hour: Number(values.get("hour")),
    minute: Number(values.get("minute")),
    weekday,
  };
}

function addLocalDays(date: LocalDate, days: number): LocalDate {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

function localKey(
  value: Pick<LocalDateTime, "year" | "month" | "day" | "hour" | "minute">,
): number {
  return Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute);
}

function sameLocalDate(left: LocalDate, right: LocalDate): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day;
}

function parseTimeOfDay(time: string): { readonly hour: number; readonly minute: number } {
  const [hour, minute] = time.split(":");
  return { hour: Number(hour), minute: Number(minute) };
}

/**
 * Resolve a (local date, wall-clock time) pair to an instant. Returns the
 * exact minute when it exists, otherwise the next valid minute (spring-
 * forward gap). Returns null when no minute on that date carries the wall
 * time and none follows it within the search window.
 */
function resolveLocalOccurrence(
  date: LocalDate,
  hour: number,
  minute: number,
  timezone: string,
): number | null {
  const nominal = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  const targetKey = nominal;
  let shifted: number | null = null;

  for (
    let candidate = nominal - SEARCH_WINDOW_MS;
    candidate <= nominal + SEARCH_WINDOW_MS;
    candidate += MINUTE_MS
  ) {
    const local = localDateTime(candidate, timezone);
    if (!sameLocalDate(local, date)) continue;
    const key = localKey(local);
    if (key === targetKey) return candidate;
    if (key > targetKey && (shifted === null || candidate < shifted)) {
      shifted = candidate;
    }
  }
  return shifted;
}

function isScheduledDay(schedule: AutomationSchedule, weekday: number): boolean {
  return schedule.kind === "daily" || (schedule.kind === "weekly" && schedule.weekday === weekday);
}

/**
 * Next firing strictly after `afterIso`, or null when nothing remains (a
 * past `once` instant). Returns null for unparseable inputs rather than
 * throwing: the decider validates schedules before they can persist.
 */
export function computeNextFireAt(schedule: AutomationSchedule, afterIso: string): string | null {
  const afterMs = Date.parse(afterIso);
  if (!Number.isFinite(afterMs)) return null;

  if (schedule.kind === "once") {
    const atMs = Date.parse(schedule.at);
    if (!Number.isFinite(atMs)) return null;
    return atMs > afterMs ? schedule.at : null;
  }

  if (!isValidAutomationTimezone(schedule.timezone)) return null;
  const { hour, minute } = parseTimeOfDay(schedule.time);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;

  const start = localDateTime(afterMs, schedule.timezone);
  for (let offset = 0; offset < 370; offset += 1) {
    const date = addLocalDays(start, offset);
    const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
    if (!isScheduledDay(schedule, weekday)) continue;
    const resolved = resolveLocalOccurrence(date, hour, minute, schedule.timezone);
    if (resolved === null || resolved <= afterMs) continue;
    return new Date(resolved).toISOString();
  }
  return null;
}

/**
 * Validate a schedule at command time. Returns an invariant detail string,
 * or null when the schedule may persist.
 */
export function validateAutomationSchedule(input: {
  readonly schedule: AutomationSchedule;
  readonly nowIso: string;
}): string | null {
  const { schedule, nowIso } = input;
  if (schedule.kind === "once") {
    if (!(Date.parse(schedule.at) > Date.parse(nowIso))) {
      return `automation fire time ${schedule.at} is not in the future`;
    }
    return null;
  }
  if (!isValidAutomationTimezone(schedule.timezone)) {
    return `automation timezone '${schedule.timezone}' is not a valid IANA timezone`;
  }
  return null;
}

export interface PlannedAutomationFiring {
  /** Stable slot identity: the stored `nextFireAt` instant that came due. */
  readonly occurrenceKey: string;
  readonly outcome: AutomationRunOutcome;
  /**
   * Next firing recomputed from NOW, never from the fired slot: missed days
   * are skipped, never backfilled. Null when nothing remains.
   */
  readonly nextFireAt: string | null;
}

/**
 * Decide what a scheduler sweep does with one stored row. Returns null when
 * the row is not due (`nextFireAt` null or in the future). A slot older than
 * the missed threshold (the server was off) fires once as `missed-then-ran`.
 */ export function planFiring(input: {
  readonly schedule: AutomationSchedule;
  readonly nextFireAt: string | null;
  readonly nowIso: string;
}): PlannedAutomationFiring | null {
  const { schedule, nextFireAt, nowIso } = input;
  if (nextFireAt === null) return null;
  const slotMs = Date.parse(nextFireAt);
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(slotMs) || !Number.isFinite(nowMs) || slotMs > nowMs) {
    return null;
  }
  return {
    occurrenceKey: nextFireAt,
    outcome: nowMs - slotMs > MISSED_THRESHOLD_MS ? "missed-then-ran" : "ran",
    nextFireAt: computeNextFireAt(schedule, nowIso),
  };
}

/** Shift an ISO instant back by milliseconds. Null for unparseable input. */
export function isoMinusMs(iso: string, millis: number): string | null {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed - millis).toISOString();
}
