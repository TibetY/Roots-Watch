// Running the checks.
//
// This used to be a setTimeout loop living on globalThis, which is the right
// shape for a process that stays up and the wrong shape for everything else.
// On Netlify there is no process between requests: the timer would be killed
// mid-sleep and the counters it kept would reset on every cold start. So the
// loop is gone, and what's left is a sweep that can be called cold, does as
// much as it can inside a time budget, and leaves the rest for the next run.
//
// Two consequences worth understanding before changing anything here:
//
//   * The sweep must be resumable, because it will be interrupted. Items are
//     taken least-recently-checked first, so an invocation that only gets
//     through half the list leaves the other half at the front of the queue.
//   * Nothing is remembered in memory. "Is this item being checked right now"
//     is a column, not a Set, because the answer has to survive the process
//     that asked.

import { evaluateItem, type CheckSummary } from "./check.server";
import { recordCheck, type LastSeen } from "./history.server";
import { loadWatchlist, type DisplayItem } from "./items.server";
import { notifyConfigFrom, readSettings, type AlertSettings } from "./settings.server";
import type { Db } from "./supabase.server";

/**
 * How long a check may sit marked "checking" before we assume the process that
 * claimed it died. Netlify kills a function at 30s at the outside; a minute is
 * comfortably past any legitimate run.
 */
const STALE_CLAIM_MS = 60_000;

export type ItemStatusRow = {
  item_id: string;
  checked_at: string;
  last_good_at: string | null;
  product: string | null;
  image: string | null;
  price: string | null;
  currency: string | null;
  source: string;
  confidence: string;
  error: string | null;
  sizes: CheckSummary["sizes"];
  alerted: string[] | null;
  buy_link: string | null;
  checking: boolean;
  last_in_stock: string[] | null;
  last_blind: boolean;
  last_price: string | null;
};

/** The stored status for every item, keyed by item id. Scoped like loadWatchlist. */
export async function loadStatuses(db: Db, userId: string): Promise<Map<string, ItemStatusRow>> {
  const { data } = await db
    .from("item_status")
    .select("*")
    .eq("user_id", userId)
    .returns<ItemStatusRow[]>();
  return new Map((data ?? []).map((row) => [row.item_id, row]));
}

/** What the UI reads. Shaped like the old in-memory summary so the routes didn't change. */
export function summaryFrom(row: ItemStatusRow | undefined | null): CheckSummary | null {
  if (!row) return null;
  return {
    checkedAt: row.checked_at,
    lastGoodAt: row.last_good_at,
    url: "",
    product: row.product,
    image: row.image,
    price: row.price,
    currency: row.currency,
    source: row.source,
    confidence: row.confidence as CheckSummary["confidence"],
    error: row.error,
    sizes: row.sizes ?? [],
    alerted: row.alerted ?? [],
    notifications: [], // per-check detail; not worth a column
    buyLink: row.buy_link,
  };
}

/**
 * Carry the last-known product details through a failed check.
 *
 * A check that couldn't read the page comes back with product, image and price
 * all null. Storing that as-is would strip the thumbnail and "$268" off the row
 * the moment a shop starts refusing us — losing information we already had, and
 * making a temporary outage look like an empty record. Only the availability
 * half of the summary should go blank.
 */
function remembering(previous: ItemStatusRow | undefined, next: CheckSummary): CheckSummary {
  if (!previous || !next.error) return next;
  return {
    ...next,
    product: next.product ?? previous.product,
    image: next.image ?? previous.image,
    price: next.price ?? previous.price,
    currency: next.currency ?? previous.currency,
    lastGoodAt: next.lastGoodAt ?? previous.last_good_at,
  };
}

/**
 * Check one item: fetch, decide whether to alert, record it, store the result.
 *
 * Never throws — a single bad item must not take down a sweep of ten.
 */
export async function checkItemNow(
  db: Db,
  userId: string,
  item: DisplayItem,
  settings: AlertSettings,
): Promise<CheckSummary> {
  const { data: before } = await db
    .from("item_status")
    .select("*")
    .eq("item_id", item.id)
    .maybeSingle<ItemStatusRow>();

  await claim(db, userId, item.id, before);

  let summary: CheckSummary;
  try {
    summary = await evaluateItem(db, userId, item, notifyConfigFrom(settings));
  } catch (error) {
    summary = placeholderSummary(item, `check failed: ${(error as Error).message ?? error}`);
  }

  const merged = remembering(before ?? undefined, summary);

  // Columns are nullable; the comparison logic isn't. Normalise once, here,
  // rather than making every reader defend against it.
  const previous: LastSeen | null = before
    ? {
        last_in_stock: before.last_in_stock ?? [],
        last_blind: before.last_blind,
        last_price: before.last_price,
      }
    : null;

  let last: LastSeen;
  try {
    last = await recordCheck(db, userId, item, merged, previous);
  } catch (error) {
    // Losing a line of history is not a reason to lose the check result.
    console.error("[sweep] couldn't record history:", error);
    last = {
      last_in_stock: before?.last_in_stock ?? [],
      last_blind: Boolean(merged.error),
      last_price: before?.last_price ?? null,
    };
  }

  await db.from("item_status").upsert(
    {
      item_id: item.id,
      user_id: userId,
      checked_at: merged.checkedAt,
      last_good_at: merged.lastGoodAt,
      product: merged.product,
      image: merged.image,
      price: merged.price == null ? null : String(merged.price),
      currency: merged.currency,
      source: merged.source,
      confidence: merged.confidence,
      error: merged.error,
      sizes: merged.sizes,
      alerted: merged.alerted,
      buy_link: merged.buyLink,
      checking: false,
      ...last,
    },
    { onConflict: "item_id" },
  );

  return merged;
}

/**
 * Mark an item as being checked, so a "Check now" click and a scheduled sweep
 * that overlap don't both fetch the page and both fire a push.
 *
 * A claim older than STALE_CLAIM_MS is ignored: the alternative is an item
 * stuck "checking" forever because one invocation was killed mid-flight.
 */
async function claim(
  db: Db,
  userId: string,
  itemId: string,
  before: ItemStatusRow | null | undefined,
): Promise<void> {
  const now = new Date().toISOString();
  if (!before) {
    await db.from("item_status").upsert(
      { item_id: itemId, user_id: userId, checked_at: now, checking: true, sizes: [] },
      { onConflict: "item_id" },
    );
    return;
  }
  // checked_at moves now, at the *start* of the check, not only when one
  // finishes. isChecking() measures the claim's age against this column, so
  // leaving it at the last completed check made every claim look stale the
  // moment the item was more than a minute overdue — which is exactly when a
  // sweep picks it up. A "Check now" click landing alongside a sweep would
  // then see checking=true, judge it expired, and fetch the page a second
  // time: two requests to the shop and two pushes to your phone for one
  // restock. It also means a check that dies mid-flight waits out the normal
  // interval instead of being retried immediately by the next sweep.
  await db.from("item_status").update({ checking: true, checked_at: now }).eq("item_id", itemId);
}

/** True when another process claimed this item recently enough to still be working. */
export function isChecking(row: ItemStatusRow | undefined | null): boolean {
  if (!row?.checking) return false;
  return Date.now() - Date.parse(row.checked_at) < STALE_CLAIM_MS;
}

function placeholderSummary(item: DisplayItem, error: string): CheckSummary {
  return {
    checkedAt: new Date().toISOString(),
    lastGoodAt: null,
    url: item.url,
    product: null,
    image: null,
    price: null,
    currency: null,
    source: "none",
    confidence: "low",
    error,
    sizes: item.sizes.map((size) => ({ wanted: size, matchedLabel: null, status: "unknown" })),
    alerted: [],
    notifications: [],
    buyLink: null,
  };
}

export type SweepResult = {
  checked: number;
  skipped: number;
  /** Items that were due but didn't fit in the budget. They lead the next run. */
  remaining: number;
  alerts: number;
  errors: string[];
};

/**
 * Check everything due for one user.
 *
 * `budgetMs` exists because a serverless function is killed on a clock, not
 * when it's finished. Rather than assume a limit, we stop early and leave the
 * queue ordered so the next invocation resumes where this one stopped.
 */
export async function sweepUser(
  db: Db,
  userId: string,
  { budgetMs = 20_000, now = Date.now() }: { budgetMs?: number; now?: number } = {},
): Promise<SweepResult> {
  const startedAt = Date.now();
  const result: SweepResult = { checked: 0, skipped: 0, remaining: 0, alerts: 0, errors: [] };

  const settings = await readSettings(db, userId);
  if (!settings.autoRun) return result;

  const [items, statuses] = await Promise.all([
    loadWatchlist(db, userId),
    loadStatuses(db, userId),
  ]);

  const due = items
    .filter((item) => item.enabled)
    .filter((item) => !isChecking(statuses.get(item.id)))
    .filter((item) => {
      const last = statuses.get(item.id)?.checked_at;
      if (!last) return true;
      // Cron granularity and per-item cadence are different things: the
      // function may run every 5 minutes while an item wants checking hourly.
      return now - Date.parse(last) >= settings.intervalMinutes * 60_000 - 30_000;
    })
    // Least recently checked first, so an interrupted sweep resumes correctly.
    .sort((a, b) => {
      const left = statuses.get(a.id)?.checked_at;
      const right = statuses.get(b.id)?.checked_at;
      return (left ? Date.parse(left) : 0) - (right ? Date.parse(right) : 0);
    });

  result.skipped = items.filter((item) => item.enabled).length - due.length;

  for (const [index, item] of due.entries()) {
    if (Date.now() - startedAt > budgetMs) {
      result.remaining = due.length - index;
      break;
    }

    // "Keep checking for <duration>" — a watch that has run out pauses itself
    // rather than being deleted, so it's still there to resume.
    if (item.expiresAt && Date.parse(item.expiresAt) <= now) {
      await db.from("items").update({ enabled: false }).eq("id", item.id);
      continue;
    }

    try {
      const summary = await checkItemNow(db, userId, item, settings);
      result.checked += 1;
      result.alerts += summary.alerted.length;
    } catch (error) {
      result.errors.push(`${item.label}: ${(error as Error).message ?? error}`);
    }
  }

  return result;
}

/** Counters for the dashboard, from the record rather than from memory. */
export async function watcherStats(
  db: Db,
  userId: string,
  settings: AlertSettings,
): Promise<{ intervalMinutes: number; autoRun: boolean; checksToday: number; alertsToday: number }> {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const [checks, alerts] = await Promise.all([
    db
      .from("checks")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("at", since),
    db
      .from("events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("at", since)
      .eq("kind", "drop")
      .eq("alerted", true),
  ]);

  return {
    intervalMinutes: settings.intervalMinutes,
    autoRun: settings.autoRun,
    // "Checks this session" meant nothing once there are no sessions.
    checksToday: checks.count ?? 0,
    alertsToday: alerts.count ?? 0,
  };
}
