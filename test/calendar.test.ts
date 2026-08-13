// The zone maths, checked against the two nights a year it can go wrong.

import { describe, expect, it } from "vitest";

import { systemCalendar, zonedCalendar } from "../app/lib/calendar";
import { emptyHistory, foldCheck, summarize } from "../app/lib/stats";

const toronto = zonedCalendar("America/Toronto");
const HOUR = 3_600_000;

describe("zonedCalendar", () => {
  it("files a late-evening instant under the local day, not the UTC one", () => {
    // 01:30 UTC on the 2nd is 21:30 on the 1st in Toronto. Getting this wrong
    // is the entire reason this module exists.
    const ms = Date.parse("2026-08-02T01:30:00Z");
    expect(toronto.dayKey(ms)).toBe("2026-08-01");
    expect(toronto.hourOf(ms)).toBe(21);
    expect(zonedCalendar("UTC").dayKey(ms)).toBe("2026-08-02");
    expect(zonedCalendar("UTC").hourOf(ms)).toBe(1);
  });

  it("finds local midnight, and it is a real instant", () => {
    const ms = Date.parse("2026-08-02T01:30:00Z");
    const midnight = toronto.startOfDay(ms);
    expect(toronto.hourOf(midnight)).toBe(0);
    expect(toronto.dayKey(midnight)).toBe("2026-08-01");
    // Nothing before it belongs to the same local day.
    expect(toronto.dayKey(midnight - 1)).toBe("2026-07-31");
  });

  it("counts a spring-forward day as 23 hours, not 24", () => {
    // Toronto springs forward at 2am on 8 March 2026.
    const before = toronto.startOfDay(Date.parse("2026-03-08T12:00:00Z"));
    const after = toronto.addDays(before, 1);
    expect((after - before) / HOUR).toBe(23);
    expect(toronto.dayKey(before)).toBe("2026-03-08");
    expect(toronto.dayKey(after)).toBe("2026-03-09");
  });

  it("counts a fall-back day as 25 hours", () => {
    // And back again at 2am on 1 November 2026.
    const before = toronto.startOfDay(Date.parse("2026-11-01T12:00:00Z"));
    const after = toronto.addDays(before, 1);
    expect((after - before) / HOUR).toBe(25);
    expect(toronto.dayKey(after)).toBe("2026-11-02");
  });

  it("keeps weekdays in the local week", () => {
    // Sunday 21:30 in Toronto, already Monday in UTC.
    const ms = Date.parse("2026-08-03T01:30:00Z");
    expect(toronto.weekdayOf(ms)).toBe(0);
    expect(zonedCalendar("UTC").weekdayOf(ms)).toBe(1);
  });

  it("falls back to the system calendar rather than throwing on a bad zone", () => {
    const bogus = zonedCalendar("Mars/Olympus_Mons");
    const ms = Date.now();
    expect(bogus.dayKey(ms)).toBe(systemCalendar.dayKey(ms));
  });
});

describe("summarize with a calendar", () => {
  it("puts an evening restock on the local day the shopper would name", () => {
    const history = emptyHistory();
    const at = "2026-08-02T01:30:00Z"; // 9:30pm on the 1st, Toronto
    foldCheck(history, { at, blind: false, inStock: ["4"], price: null, alerted: true }, toronto);

    const stats = summarize(history, ["4"], {
      days: 7,
      now: Date.parse("2026-08-03T12:00:00Z"),
      calendar: toronto,
    });

    const withDrops = stats.cells.filter((cell) => cell.drops > 0);
    expect(withDrops).toHaveLength(1);
    expect(withDrops[0].key).toBe("2026-08-01");
  });

  it("would have filed the same restock a day late in UTC", () => {
    // Not an endorsement — a guard, so the bug can't come back unnoticed.
    const utc = zonedCalendar("UTC");
    const history = emptyHistory();
    const at = "2026-08-02T01:30:00Z";
    foldCheck(history, { at, blind: false, inStock: ["4"], price: null, alerted: true }, utc);

    const stats = summarize(history, ["4"], {
      days: 7,
      now: Date.parse("2026-08-03T12:00:00Z"),
      calendar: utc,
    });
    expect(stats.cells.filter((cell) => cell.drops > 0)[0].key).toBe("2026-08-02");
  });
});
