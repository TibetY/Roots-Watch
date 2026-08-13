// One availability check, and the decision of whether it's worth telling you.
//
// Design notes that matter if you come back to this later:
//
//   * The check is layered. SFRA's Product-Variation JSON is the trusted
//     source; markup scraping is the fallback; JSON-LD fills in name/price.
//     See parse.ts for why.
//   * Alert state lives in the database (alert_state / blind_state) so a
//     restock doesn't produce an alert on every check while it lasts. Alerts
//     fire on the out-of-stock → in-stock edge, then at most once per
//     `renotifyHours` while it holds. It has to be durable and shared: the
//     scheduled sweep and a "Check now" button are different processes, and
//     both must see the same dedupe state or you get two pushes.
//   * If the parser goes blind (site redesign, bot wall, network failure) the
//     watcher says so rather than sitting quietly on "no news". Silence is
//     indistinguishable from "still sold out", which is the one failure mode
//     that loses you the thing.

import {
  IN_STOCK,
  UNKNOWN,
  buildVariationUrl,
  discoverVariationEndpoint,
  extractJsonLd,
  extractSizesFromHtml,
  extractSizesFromVariationJson,
  matchWantedSizes,
  parseProductUrl,
  summarizeJsonLd,
  type Confidence,
  type PageSize,
  type WantedSize,
} from "./parse";
import { notifyAll, type NotifyConfig, type NotifyResult } from "./notify.server";
import type { DisplayItem } from "./items.server";
import type { Db } from "./supabase.server";

// Two hours of consecutive blindness before we bother the user about it. Short
// enough to catch a real breakage the same morning, long enough to ride out a
// transient 403 or a maintenance window.
//
// Measured in wall-clock time rather than consecutive runs, which silently
// meant something different every time the check interval changed.
const BLIND_HOURS_BEFORE_ALERT = 2;

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-CA,en;q=0.9",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
};

export type CheckReport = {
  results: WantedSize[];
  allSizes: PageSize[];
  confidence: Confidence;
  source: "variation-api" | "html" | "none";
  productName: string | null;
  image: string | null;
  price: unknown;
  currency: string | null;
  error: string | null;
};

/** What the UI shows for one item's latest check. */
export type CheckSummary = {
  checkedAt: string;
  /**
   * When we last actually managed to read the page. Distinct from `checkedAt`,
   * which is just when we last tried: while a watch is blind, this is the
   * number that says how stale everything else on the row is.
   */
  lastGoodAt: string | null;
  url: string;
  product: string | null;
  image: string | null;
  price: unknown;
  currency: string | null;
  source: string;
  confidence: Confidence;
  error: string | null;
  sizes: WantedSize[];
  alerted: string[];
  notifications: NotifyResult[];
  buyLink: string | null;
};

type AlertState = {
  sizes: Record<string, { status: string; seenAt: string; notifiedAt: number | null }>;
  blindRuns: number;
  blindSince: string | null;
  blindAlertSent: boolean;
};

function sleep(ms: number) {
  return new Promise((done) => setTimeout(done, ms));
}

/** Fetch with a couple of retries — a single blip shouldn't skip a slot. */
async function fetchWithRetry(
  url: string,
  {
    attempts = 3,
    timeoutMs = 30_000,
    headers = BROWSER_HEADERS,
  }: { attempts?: number; timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(2000 * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

function blindReport(sizes: string[], message: string): CheckReport {
  return {
    results: sizes.map((size) => ({ wanted: String(size), matchedLabel: null, status: UNKNOWN })),
    allSizes: [],
    confidence: "low",
    source: "none",
    productName: null,
    image: null,
    price: null,
    currency: null,
    error: message,
  };
}

/**
 * Read a product page once and report what's on it.
 *
 * Pure read: no state written, nothing sent. Safe to call for the Add screen's
 * "Find it" preview as well as for a real check.
 */
export async function checkOnce(url: string, wantedSizes: string[]): Promise<CheckReport> {
  const { origin, pid, color } = parseProductUrl(url);

  if (!pid) {
    return blindReport(wantedSizes, "couldn't find a product id in that address");
  }

  let html: string;
  try {
    html = await fetchWithRetry(url);
  } catch (error) {
    return blindReport(wantedSizes, `couldn't load the page: ${(error as Error).message ?? error}`);
  }

  const jsonLd = summarizeJsonLd(extractJsonLd(html));

  // Preferred path: ask SFRA directly.
  let reading = null;
  let source: CheckReport["source"] = "html";
  const endpoint = discoverVariationEndpoint(html, origin);
  if (endpoint) {
    try {
      const variationUrl = buildVariationUrl(endpoint, { pid, color });
      const payload = await fetchWithRetry(variationUrl, {
        attempts: 2,
        headers: {
          ...BROWSER_HEADERS,
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
      });
      reading = extractSizesFromVariationJson(JSON.parse(payload));
      if (reading) source = "variation-api";
    } catch {
      // Fall through to markup scraping — noted in `source` on the result.
    }
  }

  if (!reading) reading = extractSizesFromHtml(html);

  return {
    results: matchWantedSizes(reading.sizes, wantedSizes),
    allSizes: reading.sizes,
    confidence: reading.confidence,
    source,
    productName: reading.productName ?? jsonLd?.name ?? null,
    image: jsonLd?.image ?? null,
    price: jsonLd?.price ?? null,
    currency: jsonLd?.currency ?? null,
    error: null,
  };
}

type SizeStateRow = {
  size: string;
  status: string;
  seen_at: string;
  notified_at: string | null;
};

type BlindStateRow = {
  blind_runs: number;
  blind_since: string | null;
  blind_alert_sent: boolean;
};

async function loadState(db: Db, itemId: string): Promise<AlertState> {
  const state: AlertState = { sizes: {}, blindRuns: 0, blindSince: null, blindAlertSent: false };

  const [sizes, blind] = await Promise.all([
    db
      .from("alert_state")
      .select("size, status, seen_at, notified_at")
      .eq("item_id", itemId)
      .returns<SizeStateRow[]>(),
    db
      .from("blind_state")
      .select("blind_runs, blind_since, blind_alert_sent")
      .eq("item_id", itemId)
      .maybeSingle<BlindStateRow>(),
  ]);

  for (const row of sizes.data ?? []) {
    state.sizes[row.size] = {
      status: row.status,
      seenAt: row.seen_at,
      notifiedAt: row.notified_at ? Date.parse(row.notified_at) : null,
    };
  }
  if (blind.data) {
    state.blindRuns = blind.data.blind_runs ?? 0;
    state.blindSince = blind.data.blind_since;
    state.blindAlertSent = blind.data.blind_alert_sent ?? false;
  }
  return state;
}

async function saveState(
  db: Db,
  userId: string,
  itemId: string,
  state: AlertState,
): Promise<void> {
  const rows = Object.entries(state.sizes).map(([size, entry]) => ({
    item_id: itemId,
    user_id: userId,
    size,
    status: entry.status,
    seen_at: entry.seenAt,
    notified_at: entry.notifiedAt ? new Date(entry.notifiedAt).toISOString() : null,
  }));

  await Promise.all([
    rows.length
      ? db.from("alert_state").upsert(rows, { onConflict: "item_id,size" })
      : Promise.resolve(),
    db.from("blind_state").upsert(
      {
        item_id: itemId,
        user_id: userId,
        blind_runs: state.blindRuns,
        blind_since: state.blindSince,
        blind_alert_sent: state.blindAlertSent,
      },
      { onConflict: "item_id" },
    ),
  ]);
}

/** Deep link that lands on the page with colour and size already chosen. */
function buyLink(url: string, size?: string | null): string {
  const target = new URL(url);
  const { pid } = parseProductUrl(url);
  if (pid && size) target.searchParams.set(`dwvar_${pid}_size`, size);
  return target.toString();
}

function sizeListText(entries: WantedSize[]): string {
  return entries.map((entry) => entry.matchedLabel ?? entry.wanted).join(" & ");
}

function formatAlert(item: DisplayItem, report: CheckReport, inStock: WantedSize[]): string {
  const name = report.productName ?? item.label;
  const priceBit = report.price ? ` (${report.currency === "CAD" ? "$" : ""}${report.price})` : "";
  const caveat =
    report.confidence === "low" ? "\n(read from page markup — double-check before buying)" : "";
  const link = buyLink(item.url, inStock[0]?.matchedLabel ?? inStock[0]?.wanted);
  return `IN STOCK: ${name}${priceBit} — size ${sizeListText(inStock)}\n${link}${caveat}`;
}

/**
 * Run one check for a watched item, update its alert state, and send the alert
 * if this is genuinely news.
 */
export async function evaluateItem(
  db: Db,
  userId: string,
  item: DisplayItem,
  notifyConfig: NotifyConfig,
  { dryRun = false } = {},
): Promise<CheckSummary> {
  const startedAt = new Date();
  const nowMs = startedAt.getTime();
  const report = await checkOnce(item.url, item.sizes);
  const state = await loadState(db, item.id);

  const inStock = report.results.filter((entry) => entry.status === IN_STOCK);
  const allUnknown = report.results.every((entry) => entry.status === UNKNOWN);

  // Alert on the transition into stock, then only every `renotifyHours` so a
  // long restock doesn't turn into a push every five minutes.
  const shouldAlert = inStock.filter((entry) => {
    const previous = state.sizes[entry.wanted] ?? {};
    if (previous.status !== IN_STOCK) return true;
    const elapsedHours = (nowMs - (previous.notifiedAt ?? 0)) / 3_600_000;
    return elapsedHours >= item.renotifyHours;
  });

  let notifications: NotifyResult[] = [];
  if (shouldAlert.length && !dryRun) {
    notifications = await notifyAll(notifyConfig, formatAlert(item, report, shouldAlert), {
      title: `Back in stock — size ${sizeListText(shouldAlert)}`,
      product: report.productName ?? item.label,
      sizes: shouldAlert.map((entry) => entry.matchedLabel ?? entry.wanted),
      url: buyLink(item.url, shouldAlert[0]?.matchedLabel ?? shouldAlert[0]?.wanted),
      confidence: report.confidence,
    });
  }

  // Track "we couldn't tell" separately from "sold out" so a broken parser
  // surfaces as its own alert instead of looking like a quiet no-restock.
  if (allUnknown) {
    state.blindRuns = (state.blindRuns ?? 0) + 1;
    // Stamped on the first blind check of a streak, so a fresh state file
    // can't look like it has been blind for hours.
    state.blindSince = state.blindSince ?? startedAt.toISOString();
  } else {
    state.blindRuns = 0;
    state.blindSince = null;
    state.blindAlertSent = false;
  }

  const blindHours = state.blindSince ? (nowMs - Date.parse(state.blindSince)) / 3_600_000 : 0;
  if (blindHours >= BLIND_HOURS_BEFORE_ALERT && !state.blindAlertSent && !dryRun) {
    const reason = report.error ?? "the size list wasn't on the page";
    await notifyAll(
      notifyConfig,
      `Can't read ${item.label} (${state.blindRuns} checks over ${blindHours.toFixed(1)}h): ` +
        `${reason}\n${item.url}`,
      { kind: "watcher-error", url: item.url },
    );
    state.blindAlertSent = true;
  }

  for (const entry of report.results) {
    const previous = state.sizes[entry.wanted] ?? {};
    const notified = shouldAlert.some((alerted) => alerted.wanted === entry.wanted);
    state.sizes[entry.wanted] = {
      status: entry.status,
      seenAt: startedAt.toISOString(),
      notifiedAt: notified ? nowMs : (previous.notifiedAt ?? null),
    };
  }

  await saveState(db, userId, item.id, state);

  return {
    checkedAt: startedAt.toISOString(),
    lastGoodAt: report.error ? null : startedAt.toISOString(),
    url: item.url,
    product: report.productName,
    image: report.image,
    price: report.price,
    currency: report.currency,
    source: report.source,
    confidence: report.confidence,
    error: report.error,
    sizes: report.results,
    alerted: shouldAlert.map((entry) => entry.wanted),
    notifications,
    buyLink: inStock.length
      ? buyLink(item.url, inStock[0]?.matchedLabel ?? inStock[0]?.wanted)
      : null,
  };
}
