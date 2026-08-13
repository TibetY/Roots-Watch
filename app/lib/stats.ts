// Reading a recorded history back as answers.
//
// The question this file exists to answer is "did I miss a drop?", and the
// honest answer has two halves: what we saw, and how much of the window we
// were actually able to see. A restock count on its own is a half-truth — if
// the watcher was off for three days, "0 drops" means nothing. So every number
// here travels with its coverage.
//
// Pure and side-effect free: no Node imports, no clock reads that aren't
// injectable. The route renders it, the console prints it, the tests pin it.

import { systemCalendar, type Calendar } from "./calendar";

/** How far back we keep anything. Older days and events are dropped on write. */
export const RETAIN_DAYS = 90;

/** A stretch with no successful read has to reach this before we call it a gap. */
export const MIN_GAP_HOURS = 2;

export type HistoryEvent =
  | { at: string; kind: "drop"; sizes: string[]; price: string | null; alerted: boolean }
  | { at: string; kind: "gone"; sizes: string[] }
  | { at: string; kind: "blind"; reason: string }
  | { at: string; kind: "clear" }
  | { at: string; kind: "price"; from: string | null; to: string | null };

/** One local calendar day, rolled up. `hours` is 24 counters of *successful* reads. */
export type DayRoll = {
  checks: number;
  reads: number;
  hits: number;
  hours: number[];
};

export type LastSeen = {
  at: string;
  /** Last *known* in-stock set. Carried through blind checks unchanged. */
  inStock: string[];
  blind: boolean;
  price: string | null;
};

export type ItemHistory = {
  version: 1;
  /** First check we actually recorded. Coverage is measured from here, not from
   *  the start of the window — we can't be blamed for a week we didn't exist. */
  since: string | null;
  last: LastSeen | null;
  events: HistoryEvent[];
  /** Keyed by local date, "YYYY-MM-DD". */
  days: Record<string, DayRoll>;
};

export function emptyHistory(): ItemHistory {
  return { version: 1, since: null, last: null, events: [], days: {} };
}

export function emptyDay(): DayRoll {
  return { checks: 0, reads: 0, hits: 0, hours: Array(24).fill(0) };
}

/** Local calendar day, not UTC — you ask "did I miss it on Tuesday" in your own timezone. */
export function dayKey(date: Date, calendar: Calendar = systemCalendar): string {
  return calendar.dayKey(date.getTime());
}

/** One check, reduced to only what history cares about. */
export type Reading = {
  at: string;
  /** We couldn't read the page, or read it and learned nothing. */
  blind: boolean;
  /** Why, when blind. */
  reason?: string;
  /** Wanted sizes buyable right now. Meaningless — and ignored — when blind. */
  inStock: string[];
  price: string | null;
  alerted: boolean;
};

/**
 * Fold one check into a history, in place.
 *
 * Kept here rather than beside the file IO so the interesting half — which
 * transitions count as a restock — can be tested without a disk.
 */
export function foldCheck(
  history: ItemHistory,
  reading: Reading,
  calendar: Calendar = systemCalendar,
): ItemHistory {
  const when = new Date(reading.at);
  if (Number.isNaN(when.getTime())) return history;

  const inStock = [...reading.inStock].sort();
  const day = (history.days[dayKey(when, calendar)] ??= emptyDay());
  day.checks += 1;
  if (!reading.blind) {
    day.reads += 1;
    day.hours[calendar.hourOf(when.getTime())] += 1;
    if (inStock.length) day.hits += 1;
  }

  const previous = history.last;
  const at = reading.at;

  if (reading.blind) {
    if (!previous?.blind) {
      push(history, {
        at,
        kind: "blind",
        reason: reading.reason ?? "the size list wasn't on the page",
      });
    }
  } else {
    if (previous?.blind) push(history, { at, kind: "clear" });

    // Compared against the last *known* set, which is carried through blind
    // checks. Otherwise recovering from an outage would report everything
    // already in stock as a brand-new drop.
    const before = new Set(previous?.inStock ?? []);
    const fresh = inStock.filter((size) => !before.has(size));
    if (fresh.length) {
      push(history, {
        at,
        kind: "drop",
        sizes: fresh,
        price: reading.price,
        alerted: reading.alerted,
      });
    }
    const went = [...before].filter((size) => !inStock.includes(size));
    if (went.length) push(history, { at, kind: "gone", sizes: went });

    if (previous && !previous.blind && previous.price && reading.price && previous.price !== reading.price) {
      push(history, { at, kind: "price", from: previous.price, to: reading.price });
    }
  }

  history.since ??= at;
  history.last = {
    at,
    inStock: reading.blind ? (previous?.inStock ?? []) : inStock,
    blind: reading.blind,
    price: reading.blind ? (previous?.price ?? null) : reading.price,
  };

  return history;
}

function push(history: ItemHistory, event: HistoryEvent): void {
  history.events.push(event);
}

/** Forget days and events past the retention window. In place. */
export function trimHistory(
  history: ItemHistory,
  now: number,
  calendar: Calendar = systemCalendar,
): ItemHistory {
  const cutoff = now - RETAIN_DAYS * 86_400_000;
  history.events = history.events.filter((event) => Date.parse(event.at) >= cutoff);
  const oldest = dayKey(new Date(cutoff), calendar);
  for (const key of Object.keys(history.days)) {
    if (key < oldest) delete history.days[key]; // ISO dates sort lexically
  }
  return history;
}

export type Drop = {
  at: string;
  /** When the last of its sizes went away. Null means we never saw it end. */
  endedAt: string | null;
  sizes: string[];
  price: string | null;
  alerted: boolean;
  hours: number;
  /** We went blind partway through, so the duration is a floor, not a fact. */
  uncertain: boolean;
};

export type Gap = { from: string; to: string; hours: number };

export type DayCell = {
  key: string;
  /** Local midnight of this day, for the tooltip. */
  at: string;
  /** 0–1 share of the day's hours we managed at least one read in. */
  coverage: number;
  checks: number;
  drops: number;
  /** False before we started recording — different from "we were dark". */
  recorded: boolean;
};

export type WindowStats = {
  days: number;
  from: string;
  to: string;
  since: string | null;
  /** Hours in the window that we could have been recording (clipped to `since`). */
  observedHours: number;
  coveredHours: number;
  /** 0–1. Zero observed hours reads as 0. */
  coverage: number;
  gaps: Gap[];
  longestGapHours: number;
  drops: Drop[];
  /** Wall-clock hours anything wanted was buyable — overlapping drops merged. */
  hoursInStock: number;
  checks: number;
  reads: number;
  /** 0–1 share of checks that came back readable. */
  reliability: number;
  cells: DayCell[];
  /** Wanted sizes with no recorded restock in the window. */
  neverSeen: string[];
  priceLow: string | null;
  priceHigh: string | null;
  /** Drop counts by local weekday (0 = Sunday) and by local hour. */
  byWeekday: number[];
  byHour: number[];
};

function numeric(price: string | null): number | null {
  if (!price) return null;
  const value = Number(String(price).replace(/[^0-9.]/g, ""));
  return Number.isFinite(value) ? value : null;
}

/**
 * Pair `drop` events with the `gone` that closes them.
 *
 * A drop is one restock occasion, possibly covering several sizes, and it isn't
 * over until the last of those sizes has gone again. A blind stretch inside a
 * drop doesn't end it — we just can't vouch for how long it really lasted, so
 * the drop is flagged and the duration read as a floor.
 */
function pairDrops(events: HistoryEvent[], endMs: number): Drop[] {
  type Open = Drop & { live: Set<string>; startMs: number };
  const open: Open[] = [];
  const done: Open[] = [];

  for (const event of events) {
    const atMs = Date.parse(event.at);
    if (event.kind === "drop") {
      open.push({
        at: event.at,
        endedAt: null,
        sizes: [...event.sizes],
        price: event.price,
        alerted: event.alerted,
        hours: 0,
        uncertain: false,
        live: new Set(event.sizes),
        startMs: atMs,
      });
      continue;
    }
    if (event.kind === "blind") {
      for (const drop of open) drop.uncertain = true;
      continue;
    }
    if (event.kind === "gone") {
      for (let index = open.length - 1; index >= 0; index -= 1) {
        const drop = open[index];
        for (const size of event.sizes) drop.live.delete(size);
        if (!drop.live.size) {
          drop.endedAt = event.at;
          done.push(drop);
          open.splice(index, 1);
        }
      }
    }
  }

  return [...done, ...open]
    .map((drop) => {
      const end = drop.endedAt ? Date.parse(drop.endedAt) : endMs;
      const { live: _live, startMs: _startMs, ...rest } = drop;
      return { ...rest, hours: Math.max(0, (end - drop.startMs) / 3_600_000) };
    })
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** Total wall-clock hours covered by a set of intervals, overlaps merged once. */
function unionHours(spans: { from: number; to: number }[]): number {
  const sorted = [...spans].sort((a, b) => a.from - b.from);
  let total = 0;
  let cursorFrom = -1;
  let cursorTo = -1;
  for (const span of sorted) {
    if (span.to <= span.from) continue;
    if (cursorTo < span.from) {
      if (cursorTo > cursorFrom) total += cursorTo - cursorFrom;
      cursorFrom = span.from;
      cursorTo = span.to;
    } else if (span.to > cursorTo) {
      cursorTo = span.to;
    }
  }
  if (cursorTo > cursorFrom) total += cursorTo - cursorFrom;
  return total / 3_600_000;
}

/**
 * Everything the History screen shows for one watch, over the last `days` days.
 *
 * `now` is a parameter so this is deterministic under test — there is no other
 * reason to pass it.
 */
export function summarize(
  history: ItemHistory,
  wantedSizes: string[],
  {
    days = 30,
    now = Date.now(),
    calendar = systemCalendar,
  }: { days?: number; now?: number; calendar?: Calendar } = {},
): WindowStats {
  const fromMs = calendar.startOfDay(calendar.addDays(now, -(days - 1)));
  const sinceMs = history.since ? Date.parse(history.since) : null;

  // Coverage is only meaningful once we were recording. Before that we aren't
  // "dark", we simply weren't there — a different claim, and the UI says so.
  const observeFrom = sinceMs === null ? now : Math.max(fromMs, sinceMs);

  // The hour we're standing in hasn't finished, so an empty one isn't a gap —
  // the next check may still land in it. It counts only once something has
  // actually been read in it, which keeps a freshly-started watch from
  // reporting "nothing recorded" a minute after its first successful check.
  const currentHourMs = calendar.startOfHour(now);
  const readThisHour =
    history.days[dayKey(new Date(currentHourMs), calendar)]?.hours?.[
      calendar.hourOf(currentHourMs)
    ] ?? 0;
  const observeTo = currentHourMs + (readThisHour > 0 ? 3_600_000 : 0);

  let observedHours = 0;
  let coveredHours = 0;
  const gaps: Gap[] = [];
  let runFrom: number | null = null;

  for (let ms = calendar.startOfHour(observeFrom); ms < observeTo; ms += 3_600_000) {
    const at = new Date(ms);
    observedHours += 1;
    const reads = history.days[dayKey(at, calendar)]?.hours?.[calendar.hourOf(ms)] ?? 0;
    if (reads > 0) {
      coveredHours += 1;
      if (runFrom !== null) {
        const hours = (ms - runFrom) / 3_600_000;
        if (hours >= MIN_GAP_HOURS) {
          gaps.push({ from: new Date(runFrom).toISOString(), to: at.toISOString(), hours });
        }
        runFrom = null;
      }
    } else if (runFrom === null) {
      runFrom = ms;
    }
  }
  if (runFrom !== null) {
    const hours = (observeTo - runFrom) / 3_600_000;
    if (hours >= MIN_GAP_HOURS) {
      gaps.push({ from: new Date(runFrom).toISOString(), to: new Date(observeTo).toISOString(), hours });
    }
  }

  const inWindow = history.events
    .filter((event) => {
      const at = Date.parse(event.at);
      return Number.isFinite(at) && at >= fromMs && at <= now;
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const drops = pairDrops(inWindow, now);

  const byWeekday = Array(7).fill(0) as number[];
  const byHour = Array(24).fill(0) as number[];
  for (const drop of drops) {
    const at = Date.parse(drop.at);
    byWeekday[calendar.weekdayOf(at)] += 1;
    byHour[calendar.hourOf(at)] += 1;
  }

  const hoursInStock = unionHours(
    drops.map((drop) => ({
      from: Date.parse(drop.at),
      to: drop.endedAt ? Date.parse(drop.endedAt) : now,
    })),
  );

  const cells: DayCell[] = [];
  let checks = 0;
  let reads = 0;
  for (let index = 0; index < days; index += 1) {
    // Stepped through the calendar rather than by 86,400,000ms: a DST day is
    // 23 or 25 hours long, and adding a flat day would drift the strip.
    const dayStart = calendar.startOfDay(calendar.addDays(fromMs, index));
    const at = new Date(dayStart);
    const key = dayKey(at, calendar);
    const day = history.days[key];
    const dayEnd = calendar.startOfDay(calendar.addDays(dayStart, 1));
    // Only the part of the day we could have been recording, so today isn't
    // permanently 60%-covered just because it hasn't happened yet.
    const liveHours = Math.max(
      0,
      (Math.min(dayEnd, now) - Math.max(at.getTime(), observeFrom)) / 3_600_000,
    );
    const litHours = day ? day.hours.filter((count) => count > 0).length : 0;
    checks += day?.checks ?? 0;
    reads += day?.reads ?? 0;
    cells.push({
      key,
      at: at.toISOString(),
      coverage: liveHours > 0 ? Math.min(1, litHours / liveHours) : 0,
      checks: day?.checks ?? 0,
      drops: drops.filter((drop) => dayKey(new Date(drop.at), calendar) === key).length,
      // A day we ran checks on is recorded even if none of them could read the
      // page — "we tried and failed" is a different claim from "we weren't here".
      recorded: liveHours > 0 || (day?.checks ?? 0) > 0,
    });
  }

  const seen = new Set(drops.flatMap((drop) => drop.sizes.map((size) => size.toUpperCase())));
  const prices = inWindow
    .flatMap((event) =>
      event.kind === "price" ? [event.from, event.to] : event.kind === "drop" ? [event.price] : [],
    )
    .map(numeric)
    .filter((value): value is number => value !== null);

  return {
    days,
    from: new Date(fromMs).toISOString(),
    to: new Date(now).toISOString(),
    since: history.since,
    observedHours,
    coveredHours,
    coverage: observedHours > 0 ? coveredHours / observedHours : 0,
    gaps: gaps.sort((a, b) => b.hours - a.hours),
    longestGapHours: gaps.reduce((max, gap) => Math.max(max, gap.hours), 0),
    drops,
    hoursInStock,
    checks,
    reads,
    reliability: checks > 0 ? reads / checks : 0,
    cells,
    neverSeen: wantedSizes.filter((size) => !seen.has(size.toUpperCase())),
    priceLow: prices.length ? prices.reduce((a, b) => Math.min(a, b)).toFixed(2) : null,
    priceHigh: prices.length ? prices.reduce((a, b) => Math.max(a, b)).toFixed(2) : null,
    byWeekday,
    byHour,
  };
}

/**
 * The one sentence that answers the question, stated at the confidence the data
 * actually supports.
 *
 * The failure mode worth avoiding is a confident "no drops" over a window we
 * barely watched — that reads as good news and is really no news at all.
 */
export function verdict(stats: WindowStats): { line: string; tone: "good" | "warn" | "none" } {
  if (!stats.observedHours) {
    if (stats.checks && !stats.reads) {
      return {
        tone: "warn",
        line: `${stats.checks} check${stats.checks === 1 ? "" : "s"} run and not one could read the page. Until that changes there is nothing here to summarise — and no basis for calling it sold out.`,
      };
    }
    if (stats.checks) {
      return {
        tone: "none",
        line: `Just started — ${stats.checks} check${stats.checks === 1 ? "" : "s"} in, less than an hour of record. Give it an hour and there'll be something to say.`,
      };
    }
    return {
      tone: "none",
      line: "Nothing recorded yet. This fills in from the next check onward — it can't reconstruct what happened before.",
    };
  }

  const pct = Math.round(stats.coverage * 100);
  const dark = Math.round(stats.observedHours - stats.coveredHours);
  const count = stats.drops.length;
  const plural = count === 1 ? "" : "s";
  const found = count ? `caught ${count} restock${plural}` : "watched it stay sold out";

  // Covering every hour we recorded is only good news if we recorded most of
  // the window. A watch two hours old has 100% coverage and knows nothing —
  // reporting that as "nothing was missed" would be the exact lie this screen
  // exists to avoid.
  // The window runs from midnight N days back, so its real span is somewhere
  // between (days-1)*24 and days*24 hours. Measure it rather than assume it.
  const windowHours = (Date.parse(stats.to) - Date.parse(stats.from)) / 3_600_000;
  if (stats.observedHours < windowHours * 0.9) {
    const span = describeHours(stats.observedHours);
    const holes =
      stats.coverage >= 0.98
        ? ""
        : ` Even inside that, ${describeHours(dark)} went unread.`;
    return {
      tone: stats.coverage >= 0.98 ? "none" : "warn",
      line: `We've only been recording this one for ${span}, and ${found} in that time. The rest of the ${stats.days} days is before our record begins — that's not a quiet stretch, it's an unwatched one.${holes}`,
    };
  }

  if (stats.coverage >= 0.98) {
    return count
      ? {
          tone: "good",
          line: `We had eyes on it ${pct}% of the last ${stats.days} days and caught ${count} restock${plural}. Nothing got past us.`,
        }
      : {
          tone: "good",
          line: `We had eyes on it ${pct}% of the last ${stats.days} days and it never came back. Nothing was missed, because there was nothing to miss.`,
        };
  }

  const lead = count ? `We caught ${count} restock${plural}, but there ` : "There ";
  const hours = dark === 1 ? "is 1 hour" : `are ${dark} hours`;
  const longest =
    stats.longestGapHours >= MIN_GAP_HOURS
      ? ` The longest single stretch was ${describeHours(stats.longestGapHours)}.`
      : "";
  return {
    tone: "warn",
    line: `${lead}${hours} in here we can't speak for — the page went unread ${100 - pct}% of the time we were recording.${longest}`,
  };
}

/** Hours as something you'd say out loud. */
export function describeHours(hours: number): string {
  if (hours < 1) {
    const minutes = Math.max(1, Math.round(hours * 60));
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  if (hours < 48) {
    const rounded = Math.round(hours);
    return `${rounded} ${rounded === 1 ? "hour" : "hours"}`;
  }
  const days = Math.round(hours / 24);
  return `${days} days`;
}

/** "Thursday mornings", when there's enough of a pattern to say it. */
export function dropPattern(stats: WindowStats): string | null {
  if (stats.drops.length < 3) return null;
  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const topDay = stats.byWeekday.indexOf(Math.max(...stats.byWeekday));
  const topHour = stats.byHour.indexOf(Math.max(...stats.byHour));
  const share = stats.byWeekday[topDay] / stats.drops.length;
  if (share < 0.5) return null;
  const partOfDay = topHour < 12 ? "morning" : topHour < 17 ? "afternoon" : "evening";
  return `Most restocks landed on a ${names[topDay]}, in the ${partOfDay}.`;
}
