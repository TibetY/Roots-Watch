// Alert settings.
//
// These used to live in `.env`, edited in place by the Settings screen. That
// stops working the moment this is hosted: Netlify's filesystem is read-only,
// and its environment variables are fixed at deploy time. So they live in a
// table now, one row per user, and the scheduled sweep reads them the same way
// the UI does.
//
// `.env` is still read at boot, but only for the things that genuinely are
// deploy-time configuration — the Supabase URL and keys.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { hasAnyChannel, type NotifyConfig } from "./notify.server";
import type { Db } from "./supabase.server";

const ENV_PATH = resolve(process.cwd(), ".env");

/**
 * Load `.env` into process.env once at startup.
 *
 * Hand-rolled rather than pulling in dotenv — it's twenty lines and keeps the
 * dependency list to the framework. Existing environment variables always win,
 * which is what makes this a no-op on Netlify, where the real values arrive as
 * configured secrets.
 */
export async function loadDotEnv(path = ENV_PATH): Promise<void> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch {
    return;
  }

  for (const line of contents.split("\n")) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    process.env[key] = rawValue.trim().replace(/^(['"])(.*)\1$/, "$2");
  }
}

export type AlertSettings = {
  webhookUrl: string;
  webhookTopic: string;
  hasChannel: boolean;
  intervalMinutes: number;
  autoRun: boolean;
  /** IANA zone. The server runs in UTC; "which day did it drop" is asked in this one. */
  timezone: string;
};

export const DEFAULT_SETTINGS: AlertSettings = {
  webhookUrl: "",
  webhookTopic: "",
  hasChannel: false,
  intervalMinutes: 10,
  autoRun: true,
  timezone: "UTC",
};

type SettingsRow = {
  webhook_url: string;
  webhook_topic: string;
  interval_minutes: number;
  auto_run: boolean;
  timezone: string;
};

function fromRow(row: SettingsRow): AlertSettings {
  const config: NotifyConfig = {
    webhookUrl: row.webhook_url ?? "",
    webhookTopic: row.webhook_topic ?? "",
  };
  return {
    ...config,
    hasChannel: hasAnyChannel(config),
    intervalMinutes: row.interval_minutes ?? DEFAULT_SETTINGS.intervalMinutes,
    autoRun: row.auto_run ?? true,
    timezone: row.timezone || DEFAULT_SETTINGS.timezone,
  };
}

/** Settings for a user, or the defaults if they've never saved any. */
export async function readSettings(db: Db, userId: string): Promise<AlertSettings> {
  const { data, error } = await db
    .from("settings")
    .select("webhook_url, webhook_topic, interval_minutes, auto_run, timezone")
    .eq("user_id", userId)
    .maybeSingle<SettingsRow>();
  // A settings read failing shouldn't take a page down with it — the defaults
  // are a truthful "nothing configured", which is what a new account has.
  if (error || !data) return { ...DEFAULT_SETTINGS };
  return fromRow(data);
}

/** Just the bit the alert sender needs. */
export function notifyConfigFrom(settings: AlertSettings): NotifyConfig {
  return { webhookUrl: settings.webhookUrl, webhookTopic: settings.webhookTopic };
}

export function validateSettings(input: {
  webhookUrl?: string;
  webhookTopic?: string;
  timezone?: string;
}) {
  const webhookUrl = String(input.webhookUrl ?? "").trim();
  if (webhookUrl) {
    let parsed: URL;
    try {
      parsed = new URL(webhookUrl);
    } catch {
      throw new Error(`"${webhookUrl}" isn't a valid web address.`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("The webhook has to be an http(s) address.");
    }
  }

  const timezone = String(input.timezone ?? "").trim();
  if (timezone && !isKnownZone(timezone)) {
    throw new Error(`"${timezone}" isn't a timezone I recognise.`);
  }

  return {
    webhookUrl,
    webhookTopic: String(input.webhookTopic ?? "").trim(),
    timezone,
  };
}

/** Ask the runtime, rather than shipping a list that goes stale. */
export function isKnownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export async function saveSettings(
  db: Db,
  userId: string,
  input: {
    webhookUrl?: string;
    webhookTopic?: string;
    timezone?: string;
    intervalMinutes?: number;
    autoRun?: boolean;
  },
): Promise<AlertSettings> {
  const next = validateSettings(input);

  const patch: Record<string, unknown> = {
    user_id: userId,
    webhook_url: next.webhookUrl,
    webhook_topic: next.webhookTopic,
    updated_at: new Date().toISOString(),
  };
  if (next.timezone) patch.timezone = next.timezone;
  if (input.intervalMinutes !== undefined) {
    const minutes = Number(input.intervalMinutes);
    if (Number.isFinite(minutes) && minutes > 0) patch.interval_minutes = Math.round(minutes);
  }
  if (input.autoRun !== undefined) patch.auto_run = Boolean(input.autoRun);

  const { data, error } = await db
    .from("settings")
    .upsert(patch, { onConflict: "user_id" })
    .select("webhook_url, webhook_topic, interval_minutes, auto_run, timezone")
    .single<SettingsRow>();
  if (error) throw new Error(`Couldn't save your settings: ${error.message}`);
  return fromRow(data!);
}

/**
 * Record the browser's timezone the first time we see it.
 *
 * Only ever widens from the 'UTC' default — if someone has deliberately set a
 * zone on the Settings screen, a laptop in an airport lounge shouldn't quietly
 * overwrite it.
 */
export async function rememberTimezone(db: Db, userId: string, zone: string): Promise<void> {
  if (!zone || !isKnownZone(zone)) return;
  const current = await readSettings(db, userId);
  if (current.timezone !== DEFAULT_SETTINGS.timezone) return;
  await db
    .from("settings")
    .upsert({ user_id: userId, timezone: zone }, { onConflict: "user_id" });
}
