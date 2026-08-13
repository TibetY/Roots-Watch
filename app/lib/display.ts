// Display helpers shared by the routes. Safe on both sides of the wire — no
// Node imports — so the console screen and the row components can both use them.

import { systemCalendar, type Calendar } from "./calendar";
import type { CheckSummary } from "./check.server";
import type { DisplayItem } from "./items.server";

/** What an item looks like to the UI: the watch plus its latest check. */
export type ItemView = DisplayItem & {
  status: CheckSummary | null;
  checking: boolean;
};

export type WatchState = "in_stock" | "blind" | "paused" | "pending" | "watching";

export function stateOf(item: ItemView): WatchState {
  if (!item.enabled) return "paused";
  const status = item.status;
  if (!status) return "pending";
  const sizes = status.sizes ?? [];
  if (sizes.some((size) => size.status === "in_stock")) return "in_stock";
  if (status.error || (sizes.length && sizes.every((size) => size.status === "unknown"))) {
    return "blind";
  }
  return "watching";
}

export function inStockSizes(item: ItemView): string[] {
  return (item.status?.sizes ?? [])
    .filter((size) => size.status === "in_stock")
    .map((size) => size.matchedLabel ?? size.wanted);
}

export function ago(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

export function until(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "now";
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  return `${Math.round(hours / 24)} days`;
}

export function money(status: CheckSummary | null): string | null {
  if (!status?.price) return null;
  const symbol = status.currency === "CAD" || status.currency === "USD" ? "$" : "";
  return `${symbol}${status.price}`;
}

/**
 * Turn a check's technical error into the sentence the design leads with.
 *
 * The raw string ("couldn't load the page: HTTP 403") is real information and
 * still gets shown, but underneath and in muted type — a row shouldn't open
 * with a lowercase stack-trace fragment. Each case names what actually went
 * wrong from the shop's side, because that's what tells you whether to wait or
 * to go look at the address yourself.
 */
export function blindReason(error: string | null | undefined): string {
  const raw = error ?? "";
  if (/product id/i.test(raw)) {
    return "That address doesn't look like a product page — it may be missing the colour you picked.";
  }
  if (/HTTP 4\d\d/i.test(raw)) {
    return "The shop turned us away. That's usually a bot check, or a page that has moved.";
  }
  if (/HTTP 5\d\d/i.test(raw)) {
    return "The shop's own site is erroring. Nothing to do but wait it out.";
  }
  if (/timed out|timeout|abort/i.test(raw)) {
    return "The shop stopped answering us in time.";
  }
  if (/couldn't load|fetch/i.test(raw)) {
    return "The shop stopped answering us.";
  }
  return "The page loaded, but the size list wasn't on it — the shop may have changed its layout.";
}

/** The line every blind row ends with, verbatim from the design. */
export const BLIND_CREED =
  "We'd rather say so than sit quiet — a silent watcher and a sold-out shelf look the same from here.";

// Formatted by hand rather than with toLocaleString: the loader renders on the
// server and hydrates on the client, and Node's default locale doesn't always
// match the browser's — which shows up as a hydration mismatch on a date.
//
// The calendar is passed in for the same reason it is everywhere else: the
// server is in UTC and the reader is not.
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Fri 8 Aug, 9:14am" */
export function stamp(iso: string, calendar: Calendar = systemCalendar): string {
  const ms = Date.parse(iso);
  const [, month, day] = calendar.dayKey(ms).split("-");
  const hour = calendar.hourOf(ms);
  const twelve = hour % 12 || 12;
  const minutes = String(calendar.minuteOf(ms)).padStart(2, "0");
  return (
    `${WEEKDAYS[calendar.weekdayOf(ms)]} ${Number(day)} ${MONTHS[Number(month) - 1]}, ` +
    `${twelve}:${minutes}${hour < 12 ? "am" : "pm"}`
  );
}

/** "8 Aug" */
export function dayStamp(iso: string, calendar: Calendar = systemCalendar): string {
  const [, month, day] = calendar.dayKey(Date.parse(iso)).split("-");
  return `${Number(day)} ${MONTHS[Number(month) - 1]}`;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Where alerts are going, in one word, for the stat row. */
export function alertDestination(settings: {
  hasChannel: boolean;
  webhookTopic: string;
  webhookUrl: string;
}): string {
  if (!settings.hasChannel) return "nowhere yet";
  if (settings.webhookTopic) return "ntfy";
  return hostOf(settings.webhookUrl) || "webhook";
}

export const INTERVALS = [
  { label: "1 min", minutes: 1 },
  { label: "5 min", minutes: 5 },
  { label: "30 min", minutes: 30 },
  { label: "1 hour", minutes: 60 },
];

export const DURATIONS = [
  { label: "1 day", days: 1 },
  { label: "2 days", days: 2 },
  { label: "1 week", days: 7 },
  { label: "Forever", days: 0 },
];
