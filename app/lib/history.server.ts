// The record of what actually happened.
//
// Was one JSON file per item holding hourly rollups; now two tables. The
// rollups existed to stop a file growing to four thousand lines a month, which
// is not a constraint Postgres has — so `checks` stores one row per check and
// coverage is computed exactly rather than to the nearest hour.
//
// What has *not* changed is app/lib/stats.ts. It still takes an ItemHistory and
// still knows nothing about where the data came from, which is why its
// twenty-two tests came through this migration untouched. This module's job is
// to reassemble that shape out of SQL.

import type { CheckSummary } from "./check.server";
import type { Db } from "./supabase.server";
import type { DisplayItem } from "./items.server";
import {
  emptyDay,
  emptyHistory,
  RETAIN_DAYS,
  type HistoryEvent,
  type ItemHistory,
} from "./stats";

type CoverageRow = { day: string; hour: number; checks: number; reads: number; hits: number };

type EventRow = {
  at: string;
  kind: HistoryEvent["kind"];
  sizes: string[] | null;
  price: string | null;
  price_from: string | null;
  price_to: string | null;
  alerted: boolean;
  reason: string | null;
};

function toEvent(row: EventRow): HistoryEvent {
  switch (row.kind) {
    case "drop":
      return {
        at: row.at,
        kind: "drop",
        sizes: row.sizes ?? [],
        price: row.price,
        alerted: row.alerted,
      };
    case "gone":
      return { at: row.at, kind: "gone", sizes: row.sizes ?? [] };
    case "blind":
      return { at: row.at, kind: "blind", reason: row.reason ?? "" };
    case "price":
      return { at: row.at, kind: "price", from: row.price_from, to: row.price_to };
    default:
      return { at: row.at, kind: "clear" };
  }
}

/**
 * Rebuild the shape stats.ts expects for one item.
 *
 * The hourly grid comes back already bucketed in the user's timezone — done in
 * Postgres, which owns the zone database and doesn't need a round trip per row.
 */
export async function readHistory(
  db: Db,
  itemId: string,
  { days = RETAIN_DAYS, timezone = "UTC" }: { days?: number; timezone?: string } = {},
): Promise<ItemHistory> {
  const from = new Date(Date.now() - days * 86_400_000).toISOString();
  const history = emptyHistory();

  const [coverage, events, first] = await Promise.all([
    db.rpc("hourly_coverage", { p_item_id: itemId, p_from: from, p_zone: timezone }),
    db
      .from("events")
      .select("at, kind, sizes, price, price_from, price_to, alerted, reason")
      .eq("item_id", itemId)
      .gte("at", from)
      .order("at", { ascending: true })
      .returns<EventRow[]>(),
    db
      .from("checks")
      .select("at")
      .eq("item_id", itemId)
      .order("at", { ascending: true })
      .limit(1)
      .maybeSingle<{ at: string }>(),
  ]);

  for (const row of (coverage.data ?? []) as CoverageRow[]) {
    const day = (history.days[row.day] ??= emptyDay());
    day.checks += Number(row.checks);
    day.reads += Number(row.reads);
    day.hits += Number(row.hits);
    if (row.hour >= 0 && row.hour < 24) day.hours[row.hour] += Number(row.reads);
  }

  history.events = (events.data ?? []).map(toEvent);
  history.since = first.data?.at ?? null;
  return history;
}

/** What gets carried forward to the next check, for comparison. */
export type LastSeen = {
  last_in_stock: string[];
  last_blind: boolean;
  last_price: string | null;
};

/**
 * File one check away, and hand back the state the next one compares against.
 *
 * It returns that state rather than writing it because the caller has to save
 * item_status anyway. Writing it here too would mean either two updates to one
 * row, or — worse — this function updating a row the caller then overwrites
 * with stale values, which would silently break every transition after the
 * first. One writer per row.
 */
export async function recordCheck(
  db: Db,
  userId: string,
  item: DisplayItem,
  summary: CheckSummary,
  previous: LastSeen | null,
): Promise<LastSeen> {
  const at = summary.checkedAt;
  if (!Number.isFinite(Date.parse(at))) {
    return previous ?? { last_in_stock: [], last_blind: false, last_price: null };
  }

  // A check that read the page but recognised none of the sizes tells us
  // nothing either — same blindness, different cause.
  const blind =
    Boolean(summary.error) ||
    (summary.sizes.length > 0 && summary.sizes.every((size) => size.status === "unknown"));
  const inStock = summary.sizes
    .filter((size) => size.status === "in_stock")
    .map((size) => size.matchedLabel ?? size.wanted)
    .sort();
  const price = summary.price == null ? null : String(summary.price);

  await db.from("checks").insert({
    item_id: item.id,
    user_id: userId,
    at,
    ok: !blind,
    in_stock: inStock,
    price,
    error: summary.error,
  });

  const events: Record<string, unknown>[] = [];
  const push = (event: Record<string, unknown>) =>
    events.push({ item_id: item.id, user_id: userId, at, ...event });

  if (blind) {
    if (!previous?.last_blind) {
      push({ kind: "blind", reason: summary.error ?? "the size list wasn't on the page" });
    }
  } else {
    if (previous?.last_blind) push({ kind: "clear" });

    const before = new Set(previous?.last_in_stock ?? []);
    const fresh = inStock.filter((size) => !before.has(size));
    if (fresh.length) {
      push({ kind: "drop", sizes: fresh, price, alerted: summary.alerted.length > 0 });
    }
    const went = [...before].filter((size) => !inStock.includes(size));
    if (went.length) push({ kind: "gone", sizes: went });

    if (previous && !previous.last_blind && previous.last_price && price && previous.last_price !== price) {
      push({ kind: "price", price_from: previous.last_price, price_to: price });
    }
  }

  if (events.length) await db.from("events").insert(events);

  return {
    // Carried through blindness unchanged: what the thing *is* doesn't change
    // because we couldn't reach it, and neither does what we last knew about it.
    last_in_stock: blind ? (previous?.last_in_stock ?? []) : inStock,
    last_blind: blind,
    last_price: blind ? (previous?.last_price ?? null) : price,
  };
}

/**
 * Drop anything past the retention window.
 *
 * Called by the sweep rather than scheduled separately — one cron is easier to
 * reason about than two, and the sweep is already the thing that runs on time.
 */
export async function pruneHistory(db: Db, retainDays = RETAIN_DAYS): Promise<void> {
  await db.rpc("prune_history", { retain_days: retainDays });
}
