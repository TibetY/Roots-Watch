// Local-time arithmetic, in whichever zone the answer is being asked from.
//
// This exists because the app moved off a laptop. It used to run where the
// person did, so `new Date().getHours()` was their hour and nothing had to say
// so. On a server it's UTC, and every restock after 8pm Toronto time would file
// itself under tomorrow — quietly, on a screen whose entire purpose is telling
// you which day something happened.
//
// stats.ts takes one of these rather than calling Intl itself, which keeps it
// pure and lets its tests run in the machine's own zone without ceremony.

export type Calendar = {
  /** "YYYY-MM-DD" for the local day containing this instant. */
  dayKey(ms: number): string;
  /** 0–23 local hour. */
  hourOf(ms: number): number;
  /** 0–59. Not always zone-invariant: India and Nepal are offset by :30 and :45. */
  minuteOf(ms: number): number;
  /** 0 = Sunday. */
  weekdayOf(ms: number): number;
  /** The instant local midnight began. */
  startOfDay(ms: number): number;
  /** The instant this local hour began. */
  startOfHour(ms: number): number;
  /** `n` local days later — 23 or 25 hours across a DST edge, not always 24. */
  addDays(ms: number, n: number): number;
};

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** The zone the process is running in — what the app did before it was hosted. */
export const systemCalendar: Calendar = {
  dayKey(ms) {
    const date = new Date(ms);
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${month}-${day}`;
  },
  hourOf: (ms) => new Date(ms).getHours(),
  minuteOf: (ms) => new Date(ms).getMinutes(),
  weekdayOf: (ms) => new Date(ms).getDay(),
  startOfDay(ms) {
    const date = new Date(ms);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  },
  startOfHour(ms) {
    const date = new Date(ms);
    date.setMinutes(0, 0, 0);
    return date.getTime();
  },
  addDays(ms, n) {
    const date = new Date(ms);
    date.setDate(date.getDate() + n);
    return date.getTime();
  },
};

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
      hourCycle: "h23", // so midnight reads 00 and not 24
    });
    formatters.set(timeZone, found);
  }
  return found;
}

type Parts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
};

function partsIn(ms: number, timeZone: string): Parts {
  const parts = formatter(timeZone).formatToParts(new Date(ms));
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "0";
  return {
    year: Number(pick("year")),
    month: Number(pick("month")),
    day: Number(pick("day")),
    hour: Number(pick("hour")),
    minute: Number(pick("minute")),
    second: Number(pick("second")),
    weekday: WEEKDAYS[pick("weekday")] ?? 0,
  };
}

/**
 * How far the zone is from UTC at this instant, in milliseconds.
 *
 * Derived per-instant rather than once, because a fixed offset is wrong twice a
 * year in every zone that observes daylight saving.
 */
function offsetAt(ms: number, timeZone: string): number {
  const parts = partsIn(ms, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    new Date(ms).getUTCMilliseconds(),
  );
  return asUtc - ms;
}

/**
 * Floor an instant to a local boundary.
 *
 * Two passes: floor using the offset where we started, then re-derive the
 * offset at the result. On a DST night the first guess can land an hour off,
 * and the second pass is what pulls it back.
 */
function floorTo(ms: number, size: number, timeZone: string): number {
  const first = offsetAt(ms, timeZone);
  const floored = Math.floor((ms + first) / size) * size;
  const second = offsetAt(floored - first, timeZone);
  return floored - second;
}

/** A calendar in a named IANA zone. Falls back to the system one if unknown. */
export function zonedCalendar(timeZone: string): Calendar {
  if (!timeZone) return systemCalendar;
  try {
    formatter(timeZone);
  } catch {
    return systemCalendar;
  }

  return {
    dayKey(ms) {
      const { year, month, day } = partsIn(ms, timeZone);
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    },
    hourOf: (ms) => partsIn(ms, timeZone).hour,
    minuteOf: (ms) => partsIn(ms, timeZone).minute,
    weekdayOf: (ms) => partsIn(ms, timeZone).weekday,
    startOfDay: (ms) => floorTo(ms, DAY, timeZone),
    startOfHour: (ms) => floorTo(ms, HOUR, timeZone),
    addDays(ms, n) {
      // Add in local space, then re-anchor: 24h of wall clock is not always
      // 24h of elapsed time.
      const offset = offsetAt(ms, timeZone);
      const moved = ms + offset + n * DAY;
      return moved - offsetAt(moved - offset, timeZone);
    },
  };
}
