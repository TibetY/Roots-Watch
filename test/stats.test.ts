import { describe, expect, it } from "vitest";

import {
  dropPattern,
  emptyDay,
  emptyHistory,
  foldCheck,
  summarize,
  trimHistory,
  verdict,
  dayKey,
  type ItemHistory,
} from "../app/lib/stats";

// A fixed local wall-clock moment. Everything below is built relative to it, so
// the suite behaves the same in any timezone.
const NOW = new Date(2026, 7, 10, 12, 30).getTime();
const HOUR = 3_600_000;

function at(hoursAgo: number): string {
  return new Date(NOW - hoursAgo * HOUR).toISOString();
}

function reading(hoursAgo: number, patch: Partial<Parameters<typeof foldCheck>[1]> = {}) {
  return { at: at(hoursAgo), blind: false, inStock: [], price: null, alerted: false, ...patch };
}

/** Mark `hours` consecutive hours as successfully read, starting `from`. */
function cover(history: ItemHistory, fromMs: number, hours: number): ItemHistory {
  for (let index = 0; index < hours; index += 1) {
    const when = new Date(fromMs + index * HOUR);
    const day = (history.days[dayKey(when)] ??= emptyDay());
    day.checks += 6;
    day.reads += 6;
    day.hours[when.getHours()] += 6;
  }
  return history;
}

/** Top of the hour, 48h back — where a two-day coverage fixture starts. */
function twoDaysAgoOnTheHour(): number {
  const start = new Date(NOW - 48 * HOUR);
  start.setMinutes(0, 0, 0);
  return start.getTime();
}

describe("foldCheck", () => {
  it("records a restock only on the edge into stock, not on every check after", () => {
    const history = emptyHistory();
    foldCheck(history, reading(5));
    foldCheck(history, reading(4, { inStock: ["4"], alerted: true }));
    foldCheck(history, reading(3, { inStock: ["4"] }));
    foldCheck(history, reading(2, { inStock: ["4"] }));

    const drops = history.events.filter((event) => event.kind === "drop");
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({ sizes: ["4"], alerted: true });
  });

  it("does not invent a restock when a blind stretch ends on something already in stock", () => {
    const history = emptyHistory();
    foldCheck(history, reading(6, { inStock: ["4"] }));
    foldCheck(history, reading(5, { blind: true, reason: "HTTP 403" }));
    foldCheck(history, reading(4, { blind: true, reason: "HTTP 403" }));
    foldCheck(history, reading(3, { inStock: ["4"] }));

    expect(history.events.filter((event) => event.kind === "drop")).toHaveLength(1);
    expect(history.events.filter((event) => event.kind === "blind")).toHaveLength(1);
    expect(history.events.filter((event) => event.kind === "clear")).toHaveLength(1);
  });

  it("keeps blind checks out of the coverage grid but still counts them as attempts", () => {
    const history = emptyHistory();
    foldCheck(history, reading(3, { blind: true }));
    const day = history.days[dayKey(new Date(NOW - 3 * HOUR))];
    expect(day.checks).toBe(1);
    expect(day.reads).toBe(0);
    expect(day.hours.every((count) => count === 0)).toBe(true);
  });

  it("carries the last known price through blindness so it doesn't log a fake move", () => {
    const history = emptyHistory();
    foldCheck(history, reading(5, { price: "68.00" }));
    foldCheck(history, reading(4, { blind: true }));
    foldCheck(history, reading(3, { price: "68.00" }));
    expect(history.events.filter((event) => event.kind === "price")).toHaveLength(0);

    foldCheck(history, reading(2, { price: "48.00" }));
    expect(history.events.filter((event) => event.kind === "price")).toHaveLength(1);
  });
});

describe("summarize", () => {
  it("pairs a drop with the gone that closes it and measures how long it lasted", () => {
    const history = emptyHistory();
    foldCheck(history, reading(10));
    foldCheck(history, reading(9, { inStock: ["4"], price: "68.00", alerted: true }));
    foldCheck(history, reading(6));

    const stats = summarize(history, ["4"], { now: NOW });
    expect(stats.drops).toHaveLength(1);
    expect(stats.drops[0].hours).toBeCloseTo(3, 5);
    expect(stats.drops[0].endedAt).not.toBeNull();
    expect(stats.drops[0].uncertain).toBe(false);
    expect(stats.hoursInStock).toBeCloseTo(3, 5);
  });

  it("holds a multi-size drop open until the last size goes", () => {
    const history = emptyHistory();
    foldCheck(history, reading(10));
    foldCheck(history, reading(9, { inStock: ["3", "5"] }));
    foldCheck(history, reading(8, { inStock: ["5"] })); // 3 sold out, 5 hangs on
    foldCheck(history, reading(5));

    const stats = summarize(history, ["3", "5"], { now: NOW });
    expect(stats.drops).toHaveLength(1);
    expect(stats.drops[0].sizes).toEqual(["3", "5"]);
    expect(stats.drops[0].hours).toBeCloseTo(4, 5);
  });

  it("flags a drop we went blind during, so its duration reads as a floor", () => {
    const history = emptyHistory();
    foldCheck(history, reading(10));
    foldCheck(history, reading(9, { inStock: ["4"] }));
    foldCheck(history, reading(8, { blind: true, reason: "HTTP 503" }));
    foldCheck(history, reading(7, { inStock: ["4"] }));
    foldCheck(history, reading(6));

    const stats = summarize(history, ["4"], { now: NOW });
    expect(stats.drops[0].uncertain).toBe(true);
  });

  it("counts overlapping drops as one stretch of wall-clock availability", () => {
    const history = emptyHistory();
    foldCheck(history, reading(10));
    foldCheck(history, reading(9, { inStock: ["3"] }));
    foldCheck(history, reading(8, { inStock: ["3", "5"] })); // second drop opens
    foldCheck(history, reading(7, { inStock: ["5"] }));
    foldCheck(history, reading(6));

    const stats = summarize(history, ["3", "5"], { now: NOW });
    expect(stats.drops).toHaveLength(2);
    // 9h ago → 6h ago is three hours of shelf time, not the four the two
    // drop windows add up to.
    expect(stats.hoursInStock).toBeCloseTo(3, 5);
  });

  it("reports full coverage when every hour since recording began has a read", () => {
    const history = emptyHistory();
    history.since = at(48);
    cover(history, twoDaysAgoOnTheHour(), 48);

    const stats = summarize(history, [], { now: NOW });
    expect(stats.observedHours).toBe(48);
    expect(stats.coveredHours).toBe(48);
    expect(stats.coverage).toBe(1);
    expect(stats.gaps).toHaveLength(0);
  });

  it("finds the hours nobody was looking", () => {
    const history = emptyHistory();
    history.since = at(48);
    const start = twoDaysAgoOnTheHour();
    cover(history, start, 20);
    cover(history, start + 26 * HOUR, 22); // six-hour hole in the middle

    const stats = summarize(history, [], { now: NOW });
    expect(stats.coveredHours).toBe(42);
    expect(stats.gaps).toHaveLength(1);
    expect(stats.gaps[0].hours).toBe(6);
    expect(stats.longestGapHours).toBe(6);
  });

  it("does not count the time before recording started as a gap", () => {
    const history = emptyHistory();
    history.since = at(4);
    const start = new Date(NOW - 4 * HOUR);
    start.setMinutes(0, 0, 0);
    cover(history, start.getTime(), 4);

    const stats = summarize(history, [], { days: 30, now: NOW });
    expect(stats.gaps).toHaveLength(0);
    expect(stats.observedHours).toBeLessThanOrEqual(4);
    expect(stats.cells).toHaveLength(30);
    expect(stats.cells[0].recorded).toBe(false);
    expect(stats.cells.at(-1)?.recorded).toBe(true);
  });

  it("names the sizes that never once came back", () => {
    const history = emptyHistory();
    foldCheck(history, reading(9, { inStock: ["3"] }));
    const stats = summarize(history, ["3", "5", "7"], { now: NOW });
    expect(stats.neverSeen).toEqual(["5", "7"]);
  });

  it("keeps events older than the window out of the counts", () => {
    const history = emptyHistory();
    foldCheck(history, reading(24 * 40, { inStock: ["4"] })); // 40 days back
    foldCheck(history, reading(24 * 40 - 1));

    expect(summarize(history, ["4"], { days: 30, now: NOW }).drops).toHaveLength(0);
    expect(summarize(history, ["4"], { days: 90, now: NOW }).drops).toHaveLength(1);
  });
});

describe("verdict", () => {
  it("refuses to call a barely-watched window quiet", () => {
    const history = emptyHistory();
    history.since = at(48);
    cover(history, twoDaysAgoOnTheHour(), 10); // 10 of 48 hours

    const call = verdict(summarize(history, ["4"], { days: 2, now: NOW }));
    expect(call.tone).toBe("warn");
    expect(call.line).toMatch(/can't speak for/);
    // The dangerous phrasing is a confident zero. It must not appear.
    expect(call.line).not.toMatch(/[Nn]othing (was missed|got past)/);
  });

  it("says so plainly when the window really was covered", () => {
    const history = emptyHistory();
    history.since = at(48);
    cover(history, twoDaysAgoOnTheHour(), 48);

    const call = verdict(summarize(history, ["4"], { days: 2, now: NOW }));
    expect(call.tone).toBe("good");
    expect(call.line).toMatch(/nothing to miss/i);
  });

  it("will not read a young watch's full coverage as a covered month", () => {
    // Two perfectly-watched days out of thirty is not a quiet month.
    const history = emptyHistory();
    history.since = at(48);
    cover(history, twoDaysAgoOnTheHour(), 48);

    const call = verdict(summarize(history, ["4"], { days: 30, now: NOW }));
    expect(call.tone).toBe("none");
    expect(call.line).toMatch(/only been recording this one for 2 days/);
    expect(call.line).toMatch(/unwatched one/);
    expect(call.line).not.toMatch(/[Nn]othing (was missed|got past)/);
  });

  it("has a distinct voice for having no record at all", () => {
    const call = verdict(summarize(emptyHistory(), ["4"], { now: NOW }));
    expect(call.tone).toBe("none");
    expect(call.line).toMatch(/can't reconstruct/);
  });

  it("counts the hour in progress once something has been read in it", () => {
    // A watch whose very first check just succeeded shouldn't report itself as
    // having recorded nothing — the hour isn't over, but the read happened.
    const history = emptyHistory();
    foldCheck(history, reading(0));

    const stats = summarize(history, ["4"], { now: NOW });
    expect(stats.observedHours).toBe(1);
    expect(stats.coverage).toBe(1);
    expect(stats.cells.at(-1)?.recorded).toBe(true);
    // One covered hour is not a covered month, and must not read as one.
    expect(verdict(stats).line).toMatch(/only been recording this one for 1 hour/);
    expect(verdict(stats).line).not.toMatch(/100%/);
  });

  it("will not call a page sold out when no check has ever read it", () => {
    const history = emptyHistory();
    foldCheck(history, reading(0, { blind: true, reason: "HTTP 403" }));

    const stats = summarize(history, ["4"], { now: NOW });
    expect(stats.observedHours).toBe(0);
    expect(stats.checks).toBe(1);
    expect(stats.reads).toBe(0);
    // The day still counts as recorded: we were here, we just couldn't see.
    expect(stats.cells.at(-1)?.recorded).toBe(true);

    const call = verdict(stats);
    expect(call.tone).toBe("warn");
    expect(call.line).toMatch(/no basis for calling it sold out/);
  });
});

describe("dropPattern", () => {
  it("stays quiet until there are enough drops to mean anything", () => {
    const history = emptyHistory();
    foldCheck(history, reading(50, { inStock: ["4"] }));
    foldCheck(history, reading(49));
    expect(dropPattern(summarize(history, ["4"], { now: NOW }))).toBeNull();
  });

  it("names the day when most drops share one", () => {
    const history = emptyHistory();
    // Three restocks exactly one week apart — same weekday, same hour.
    for (const weeksBack of [1, 2, 3]) {
      foldCheck(history, reading(weeksBack * 168 + 1, { inStock: ["4"] }));
      foldCheck(history, reading(weeksBack * 168));
    }
    const pattern = dropPattern(summarize(history, ["4"], { days: 90, now: NOW }));
    expect(pattern).toMatch(/Most restocks landed on a \w+day/);
  });
});

describe("trimHistory", () => {
  it("drops days and events past the retention window", () => {
    const history = emptyHistory();
    foldCheck(history, reading(24 * 120, { inStock: ["4"] })); // 120 days back
    foldCheck(history, reading(1));

    trimHistory(history, NOW);
    // The 120-day-old drop goes; the recent check's own event survives.
    expect(history.events.some((event) => event.kind === "drop")).toBe(false);
    expect(history.events.every((event) => Date.parse(event.at) >= NOW - 90 * 24 * HOUR)).toBe(true);
    expect(Object.keys(history.days)).toEqual([dayKey(new Date(NOW - HOUR))]);
  });
});
