import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";

const WEEKDAY_HEADERS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const WEEKDAY_HEADER_LABELS: Record<(typeof WEEKDAY_HEADERS)[number], string> = {
  sun: "S",
  mon: "M",
  tue: "T",
  wed: "W",
  thu: "T",
  fri: "F",
  sat: "S",
};
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

interface DateTimeParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour24: number;
  readonly minute: number;
}

function partsFromIso(iso: string, fallback: Date): DateTimeParts {
  const date = new Date(iso);
  const base = Number.isNaN(date.getTime()) ? fallback : date;
  return {
    year: base.getFullYear(),
    month: base.getMonth(),
    day: base.getDate(),
    hour24: base.getHours(),
    minute: base.getMinutes(),
  };
}

function toIso(parts: DateTimeParts): string {
  return new Date(parts.year, parts.month, parts.day, parts.hour24, parts.minute).toISOString();
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function formatTrigger(parts: DateTimeParts): string {
  const date = new Date(parts.year, parts.month, parts.day, parts.hour24, parts.minute);
  return date.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** One scrollable numeric option column (hour / minute). Fully theme-styled. */
function TimeColumn(props: {
  readonly label: string;
  readonly options: ReadonlyArray<number>;
  readonly value: number;
  readonly format: (value: number) => string;
  readonly onChange: (value: number) => void;
}) {
  const scrollSelectedIntoView = useCallback((node: HTMLButtonElement | null) => {
    node?.scrollIntoView({ block: "nearest" });
  }, []);
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="text-center text-[11px] text-muted-foreground">{props.label}</span>
      <div
        role="radiogroup"
        aria-label={props.label}
        className="flex h-32 flex-col gap-px overflow-y-auto rounded-md border border-input p-1"
      >
        {props.options.map((option) => {
          const selected = option === props.value;
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={selected}
              ref={selected ? scrollSelectedIntoView : undefined}
              onClick={() => props.onChange(option)}
              className={cn(
                "cursor-pointer rounded px-1 py-1 text-center text-sm",
                selected
                  ? "bg-accent font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {props.format(option)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Compact calendar + time picker for one-off scheduled tasks. The native
 * datetime-local popup renders an oversized, off-brand calendar, so the
 * editor uses this popover instead (daily/weekly times keep the plain
 * time field, which has no popup problem).
 */
export function ScheduledDatePicker(props: {
  readonly value: string;
  readonly onChange: (iso: string) => void;
  readonly id?: string;
}) {
  const [open, setOpen] = useState(false);
  const now = useMemo(() => new Date(), []);
  const parts = useMemo(() => partsFromIso(props.value, now), [props.value, now]);
  const [viewYear, setViewYear] = useState(parts.year);
  const [viewMonth, setViewMonth] = useState(parts.month);
  const today = useMemo(() => startOfDay(now), [now]);

  const cells = useMemo(() => {
    const first = new Date(viewYear, viewMonth, 1).getDay();
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const daysInPreviousMonth = new Date(viewYear, viewMonth, 0).getDate();
    const cells: Array<{ day: number; monthOffset: -1 | 0 | 1 }> = [];
    for (let index = first - 1; index >= 0; index -= 1) {
      cells.push({ day: daysInPreviousMonth - index, monthOffset: -1 });
    }
    for (let day = 1; day <= daysInMonth; day += 1) {
      cells.push({ day, monthOffset: 0 });
    }
    while (cells.length % 7 !== 0 || cells.length < 35) {
      const last = cells[cells.length - 1]!;
      cells.push({
        day: last.monthOffset === 1 ? last.day + 1 : 1,
        monthOffset: 1,
      });
    }
    return cells.slice(0, 42);
  }, [viewYear, viewMonth]);

  const shiftMonth = (delta: number) => {
    const date = new Date(viewYear, viewMonth + delta, 1);
    setViewYear(date.getFullYear());
    setViewMonth(date.getMonth());
  };

  const pickDay = (day: number, monthOffset: -1 | 0 | 1) => {
    const date = new Date(viewYear, viewMonth + monthOffset, day);
    if (startOfDay(date) < today) return;
    props.onChange(
      toIso({ ...parts, year: date.getFullYear(), month: date.getMonth(), day: date.getDate() }),
    );
  };

  const setTime = (hour24: number, minute: number) => {
    props.onChange(toIso({ ...parts, hour24, minute }));
  };

  const hour12 = parts.hour24 % 12 === 0 ? 12 : parts.hour24 % 12;
  const ampm = parts.hour24 < 12 ? "AM" : "PM";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            id={props.id}
            type="button"
            variant="outline"
            className="w-full justify-start font-normal"
          >
            <span className="flex-1 truncate text-left">{formatTrigger(parts)}</span>
            <ChevronDownIcon className="size-4 opacity-60" />
          </Button>
        }
      />
      <PopoverPopup side="bottom" align="start" className="w-[min(21rem,calc(100vw-1.5rem))] p-3">
        <div className="flex items-center justify-between pb-2">
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Previous month"
            onClick={() => shiftMonth(-1)}
          >
            <ChevronLeftIcon />
          </Button>
          <span className="text-sm font-medium">
            {MONTH_NAMES[viewMonth]} {viewYear}
          </span>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Next month"
            onClick={() => shiftMonth(1)}
          >
            <ChevronRightIcon />
          </Button>
        </div>
        <div className="grid grid-cols-7 gap-0.5 text-center text-xs text-muted-foreground">
          {WEEKDAY_HEADERS.map((day) => (
            <span key={day} className="py-1">
              {WEEKDAY_HEADER_LABELS[day]}
            </span>
          ))}
          {cells.map((cell) => {
            const date = new Date(viewYear, viewMonth + cell.monthOffset, cell.day);
            const disabled = startOfDay(date) < today;
            const selected =
              cell.monthOffset === 0 &&
              parts.year === date.getFullYear() &&
              parts.month === date.getMonth() &&
              parts.day === cell.day;
            return (
              <button
                key={`${viewYear}-${viewMonth}-${cell.monthOffset}-${cell.day}`}
                type="button"
                disabled={disabled}
                onClick={() => pickDay(cell.day, cell.monthOffset)}
                className={cn(
                  "cursor-pointer rounded-md py-1.5 text-sm hover:bg-accent disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent",
                  cell.monthOffset !== 0 && "opacity-50",
                  selected && "bg-primary text-primary-foreground hover:bg-primary",
                )}
              >
                {cell.day}
              </button>
            );
          })}
        </div>
        <div className="flex items-start gap-1.5 pt-3">
          <TimeColumn
            label="Hour"
            value={hour12}
            format={pad2}
            onChange={(next12) => {
              const next24 = ampm === "AM" ? next12 % 12 : (next12 % 12) + 12;
              setTime(next24, parts.minute);
            }}
            options={Array.from({ length: 12 }, (_, index) => index + 1)}
          />
          <TimeColumn
            label="Minute"
            value={parts.minute}
            format={pad2}
            onChange={(minute) => setTime(parts.hour24, minute)}
            options={Array.from({ length: 60 }, (_, minute) => minute)}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-center text-[11px] text-muted-foreground">AM / PM</span>
            <div
              role="radiogroup"
              aria-label="AM or PM"
              className="flex h-32 flex-col justify-center gap-1 rounded-md border border-input p-1"
            >
              {(["AM", "PM"] as const).map((option) => {
                const selected = option === ampm;
                return (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() =>
                      setTime(option === "AM" ? hour12 % 12 : (hour12 % 12) + 12, parts.minute)
                    }
                    className={cn(
                      "cursor-pointer rounded px-1 py-1 text-center text-sm",
                      selected
                        ? "bg-accent font-medium text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {option}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
