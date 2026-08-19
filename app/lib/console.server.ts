// The Console screen's command interpreter.
//
// This is a real driver for the watcher, not a simulation: every command runs
// the same server code the buttons do. `check` really fetches the page and can
// really fire your push notification; `sizes` really rewrites the watchlist.
// The screen says as much, because a console that quietly faked its output
// would be worse than not having one.

import {
  checkItemNow,
  loadStatuses,
  summaryFrom,
  watcherStats,
  type ItemStatusRow,
} from "./watcher.server";
import { readHistory } from "./history.server";
import { loadWatchlist, removeItem, updateItem, type DisplayItem } from "./items.server";
import { notifyAll } from "./notify.server";
import { notifyConfigFrom, readSettings, saveSettings } from "./settings.server";
import { zonedCalendar } from "./calendar";
import { stamp, stateOf, type ItemView } from "./display";
import { describeHours, summarize, verdict } from "./stats";
import type { Db } from "./supabase.server";

export type LineKind = "dim" | "cmd" | "ok" | "err" | "out";
export type ConsoleLine = { text: string; kind: LineKind };

/**
 * The sidebar list. Kept to ten rows on purpose: the aside is a fixed 520px
 * to match the console pane, and more than ten rows clips the last one
 * mid-description at the fold. `alt` is a second form shown beside the
 * runnable command rather than earning its own row.
 */
export const CONSOLE_HELP: { cmd: string; alt?: string; desc: string }[] = [
  { cmd: "ls", desc: "Every watch, one line each." },
  { cmd: "status", alt: "past 1", desc: "Now; or watch #1 over 30 days." },
  { cmd: "check", alt: "check 1", desc: "Check everything, or just watch #1." },
  { cmd: "sizes 1 3,5", desc: "Set the sizes on watch #1." },
  { cmd: "interval 5m", desc: "1m · 5m · 30m · 1h." },
  { cmd: "for 1 2d", desc: "1d · 2d · 1w · forever." },
  { cmd: "pause 1", alt: "resume 1", desc: "Stop or restart checking a watch." },
  { cmd: "rm 1", desc: "Stop watching and remove it." },
  { cmd: "notify test", desc: "Send a test push." },
  { cmd: "help", alt: "clear", desc: "This list; wipe the console." },
];

const INTERVAL_WORDS: Record<string, number> = {
  "1m": 1,
  "5m": 5,
  "30m": 30,
  "1h": 60,
  "60m": 60,
};
/** Windows the History screen offers, mirrored here so `past 1 7` agrees with it. */
const WINDOW_DAYS = [7, 30, 90];

const DURATION_WORDS: Record<string, number> = {
  "1d": 1,
  "2d": 2,
  "1w": 7,
  forever: 0,
  inf: 0,
};

function pad(value: string, width: number) {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

/** Resolve a 1-based index from `ls` to a real watch. */
function pick(items: DisplayItem[], token: string): DisplayItem | null {
  const index = Number(token);
  if (!Number.isInteger(index) || index < 1 || index > items.length) return null;
  return items[index - 1];
}

function statusWord(
  item: DisplayItem,
  statuses: Map<string, ItemStatusRow>,
): { word: string; kind: LineKind } {
  const view: ItemView = { ...item, status: summaryFrom(statuses.get(item.id)), checking: false };
  const state = stateOf(view);
  if (state === "in_stock") return { word: "in-stock", kind: "ok" };
  if (state === "blind") return { word: "unknown", kind: "err" };
  if (state === "paused") return { word: "paused", kind: "dim" };
  if (state === "pending") return { word: "pending", kind: "dim" };
  return { word: "watching", kind: "out" };
}

/**
 * Run one console command.
 *
 * @returns the lines to append. `clear` is signalled with a null return.
 */
export async function runConsoleCommand(
  db: Db,
  userId: string,
  raw: string,
): Promise<ConsoleLine[] | null> {
  const input = raw.trim();
  if (!input) return [];

  const [verb, ...rest] = input.split(/\s+/);
  const command = verb.toLowerCase();
  const out: ConsoleLine[] = [];

  if (command === "clear") return null;

  if (command === "help") {
    for (const entry of CONSOLE_HELP) {
      out.push({ text: `${pad(entry.cmd, 22)}${entry.desc}`, kind: "out" });
    }
    return out;
  }

  const [items, statuses, settings] = await Promise.all([
    loadWatchlist(db, userId),
    loadStatuses(db, userId),
    readSettings(db, userId),
  ]);

  if (command === "ls" || command === "list") {
    if (!items.length) {
      out.push({ text: "nothing being watched — add one from the Add screen", kind: "dim" });
      return out;
    }
    out.push({ text: "#  STATUS     SIZES      EVERY    ITEM", kind: "dim" });
    items.forEach((item, index) => {
      const { word, kind } = statusWord(item, statuses);
      const line =
        pad(String(index + 1), 3) +
        pad(word, 11) +
        pad(item.sizes.join(",") || "—", 11) +
        pad(`${settings.intervalMinutes}m`, 9) +
        item.label;
      out.push({ text: line, kind });
    });
    const watcher = await watcherStats(db, userId, settings);
    out.push({
      text: `${items.length} watch${items.length === 1 ? "" : "es"} · ${watcher.checksToday} checks today`,
      kind: "dim",
    });
    return out;
  }

  if (command === "status") {
    const watcher = await watcherStats(db, userId, settings);
    out.push({ text: `checking   ${watcher.autoRun ? "running" : "paused"}`, kind: "out" });
    out.push({ text: `interval   every ${watcher.intervalMinutes} min`, kind: "out" });
    out.push({
      text: `notify     ${
        settings.hasChannel
          ? settings.webhookTopic
            ? `ntfy · ${settings.webhookTopic}`
            : settings.webhookUrl
          : "not set up"
      }`,
      kind: settings.hasChannel ? "out" : "err",
    });
    out.push({ text: `renotify   6 hours`, kind: "out" });
    out.push({ text: `timezone   ${settings.timezone}`, kind: "out" });
    out.push({
      text: `today      ${watcher.checksToday} checks · ${watcher.alertsToday} alerts sent`,
      kind: "dim",
    });
    return out;
  }

  if (command === "past" || command === "history") {
    const target = pick(items, rest[0] ?? "");
    if (!target) {
      out.push({ text: "usage: past <#> [days]   (see `ls`)", kind: "err" });
      return out;
    }
    const days = WINDOW_DAYS.includes(Number(rest[1])) ? Number(rest[1]) : 30;
    const calendar = zonedCalendar(settings.timezone);
    const history = await readHistory(db, target.id, { days, timezone: settings.timezone });
    const stats = summarize(history, target.sizes, { days, calendar });
    const call = verdict(stats);

    out.push({ text: `${target.label} — last ${days} days`, kind: "dim" });
    out.push({
      text: `  restocks   ${stats.drops.length}${
        stats.drops.length ? ` · ${describeHours(stats.hoursInStock)} in stock all told` : ""
      }`,
      kind: stats.drops.length ? "ok" : "out",
    });
    out.push({
      text:
        `  readable   ${Math.round(stats.coverage * 100)}% of ${Math.round(stats.observedHours)}h` +
        (stats.longestGapHours ? ` · longest dark stretch ${describeHours(stats.longestGapHours)}` : ""),
      kind: stats.coverage >= 0.98 ? "out" : "err",
    });
    out.push({ text: `  checks     ${stats.checks} (${stats.reads} read ok)`, kind: "out" });
    for (const drop of stats.drops.slice(0, 8)) {
      out.push({
        text: `  ${stamp(drop.at, calendar)}  size ${drop.sizes.join(" & ")} · ${describeHours(drop.hours)}${
          drop.alerted ? " · alerted" : ""
        }`,
        kind: "ok",
      });
    }
    out.push({ text: call.line, kind: call.tone === "good" ? "ok" : "dim" });
    return out;
  }

  if (command === "check") {
    const target = rest[0] ? pick(items, rest[0]) : null;
    if (rest[0] && !target) {
      out.push({ text: `no watch #${rest[0]} — try \`ls\``, kind: "err" });
      return out;
    }
    const targets = target ? [target] : items.filter((item) => item.enabled);
    if (!targets.length) {
      out.push({ text: "nothing enabled to check", kind: "err" });
      return out;
    }

    for (const item of targets) {
      const summary = await checkItemNow(db, userId, item, settings);
      const hits = summary.sizes.filter((size) => size.status === "in_stock");
      out.push({
        text: `${item.label} — via ${summary.source} (${summary.confidence} confidence)`,
        kind: "dim",
      });
      if (summary.error) {
        out.push({ text: `  ${summary.error}`, kind: "err" });
      } else if (hits.length) {
        out.push({
          text: `  size ${hits.map((h) => h.matchedLabel ?? h.wanted).join(", ")} in stock`,
          kind: "ok",
        });
        if (summary.notifications.some((n) => n.ok)) {
          out.push({ text: "  push sent", kind: "ok" });
        }
        if (summary.buyLink) out.push({ text: `  ${summary.buyLink}`, kind: "out" });
      } else {
        out.push({
          text: `  ${summary.sizes.map((s) => `${s.matchedLabel ?? s.wanted}: sold out`).join(", ")}`,
          kind: "out",
        });
      }
    }
    const fresh = await loadStatuses(db, userId);
    const anyHit = targets.some((item) =>
      (summaryFrom(fresh.get(item.id))?.sizes ?? []).some((size) => size.status === "in_stock"),
    );
    out.push({ text: `exit ${anyHit ? 10 : 0}`, kind: "dim" });
    return out;
  }

  if (command === "sizes") {
    const target = pick(items, rest[0] ?? "");
    if (!target) {
      out.push({ text: "usage: sizes <#> 3,5   (see `ls` for numbers)", kind: "err" });
      return out;
    }
    const wanted = (rest[1] ?? "").split(/[,\s]+/).filter(Boolean);
    if (!wanted.length) {
      out.push({ text: "usage: sizes <#> 3,5", kind: "err" });
      return out;
    }
    // Warn against the page's known sizes when we have them, but don't block:
    // a size can legitimately appear later.
    const known = (summaryFrom(statuses.get(target.id))?.sizes ?? []).map((size) =>
      (size.matchedLabel ?? size.wanted).toUpperCase(),
    );
    try {
      await updateItem(db, target.id, { sizes: wanted });
      out.push({ text: `${target.label}: watching ${wanted.join(", ")}`, kind: "ok" });
      const unseen = known.length
        ? wanted.filter((size) => !known.includes(size.toUpperCase()))
        : [];
      if (unseen.length) {
        out.push({
          text: `note: ${unseen.join(", ")} wasn't on the page last check — it'll read as unknown until it appears`,
          kind: "dim",
        });
      }
    } catch (error) {
      out.push({ text: (error as Error).message, kind: "err" });
    }
    return out;
  }

  if (command === "interval") {
    const minutes = INTERVAL_WORDS[(rest[0] ?? "").toLowerCase()];
    if (!minutes) {
      out.push({ text: "usage: interval 1m | 5m | 30m | 1h", kind: "err" });
      return out;
    }
    await saveSettings(db, userId, { intervalMinutes: minutes });
    out.push({ text: `checking every ${minutes} min`, kind: "ok" });
    return out;
  }

  if (command === "for") {
    const target = pick(items, rest[0] ?? "");
    const days = DURATION_WORDS[(rest[1] ?? "").toLowerCase()];
    if (!target || days === undefined) {
      out.push({ text: "usage: for <#> 1d | 2d | 1w | forever", kind: "err" });
      return out;
    }
    await updateItem(db, target.id, { durationDays: days });
    out.push({
      text: days
        ? `${target.label}: will keep checking for ${rest[1].toLowerCase()}`
        : `${target.label}: will keep checking indefinitely`,
      kind: "ok",
    });
    return out;
  }

  if (command === "pause" || command === "resume") {
    const target = pick(items, rest[0] ?? "");
    if (!target) {
      out.push({ text: `usage: ${command} <#>   (see \`ls\`)`, kind: "err" });
      return out;
    }
    await updateItem(db, target.id, { enabled: command === "resume" });
    out.push({ text: `${target.label}: ${command === "resume" ? "resumed" : "paused"}`, kind: "ok" });
    return out;
  }

  if (command === "rm" || command === "remove") {
    const target = pick(items, rest[0] ?? "");
    if (!target) {
      out.push({ text: "usage: rm <#>   (see `ls`)", kind: "err" });
      return out;
    }
    // Status, alert state, checks and events go with it, by cascade.
    await removeItem(db, target.id);
    out.push({ text: `removed ${target.label}`, kind: "ok" });
    return out;
  }

  if (command === "notify") {
    if ((rest[0] ?? "") !== "test") {
      out.push({ text: "usage: notify test", kind: "err" });
      return out;
    }
    if (!settings.hasChannel) {
      out.push({ text: "no webhook configured — set one under Settings", kind: "err" });
      return out;
    }
    const [result] = await notifyAll(
      notifyConfigFrom(settings),
      "Test notification from the stdby console.",
      { title: "STDBY — test" },
    );
    out.push(
      result?.ok
        ? { text: "push sent — check your phone", kind: "ok" }
        : { text: `failed: ${result?.detail ?? "unknown error"}`, kind: "err" },
    );
    return out;
  }

  out.push({ text: `unknown command: ${command} — try \`help\``, kind: "err" });
  return out;
}
