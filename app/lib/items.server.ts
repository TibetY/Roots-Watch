// The watchlist: what you've asked us to watch.
//
// Was data/watchlist.json; now a Postgres table. The validation is unchanged
// and still runs here rather than in the database — a check constraint can only
// reject a row, and "Only http(s) addresses can be watched" is a sentence the
// Add screen needs to show someone. The constraint in the schema is the backstop
// for anything that reaches the table another way.
//
// The read-modify-write queue this module used to carry is gone: it existed
// because two concurrent requests could clobber one JSON file, which is not a
// problem a database has.

import type { Db } from "./supabase.server";

export type WatchItem = {
  id: string;
  label: string | null;
  url: string;
  sizes: string[];
  renotifyHours: number;
  /** 0 means "keep checking forever". */
  durationDays: number;
  expiresAt: string | null;
  enabled: boolean;
  createdAt: string;
};

/** A WatchItem as the UI sees it — label always filled in. */
export type DisplayItem = WatchItem & { label: string };

export const DEFAULT_RENOTIFY_HOURS = 6;

type ItemRow = {
  id: string;
  label: string | null;
  url: string;
  sizes: string[] | null;
  renotify_hours: number;
  duration_days: number;
  expires_at: string | null;
  enabled: boolean;
  created_at: string;
};

/** A friendly-ish label from the URL slug when the user didn't give one. */
function deriveLabel(url: string): string {
  try {
    const slug = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    const words = slug
      .replace(/-\w{5,}\.html$/i, "")
      .replace(/\.html$/i, "")
      .split("-")
      .filter(Boolean);
    if (!words.length) return "Watched item";
    return words.map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
  } catch {
    return "Watched item";
  }
}

function forDisplay(row: ItemRow): DisplayItem {
  return {
    id: row.id,
    label: row.label ?? deriveLabel(row.url),
    url: row.url,
    sizes: row.sizes ?? [],
    renotifyHours: row.renotify_hours,
    durationDays: row.duration_days,
    expiresAt: row.expires_at,
    enabled: row.enabled,
    createdAt: row.created_at,
  };
}

function parseSizes(input: unknown): string[] {
  const list = Array.isArray(input) ? input : String(input ?? "").split(",");
  return list.map((size) => String(size).trim()).filter(Boolean);
}

function expiryFrom(durationDays: number, from = Date.now()): string {
  return new Date(from + durationDays * 86_400_000).toISOString();
}

export type ItemInput = {
  url?: string;
  sizes?: string[] | string;
  label?: string | null;
  renotifyHours?: number;
  durationDays?: number;
  enabled?: boolean;
};

type ItemPatch = Partial<Omit<ItemRow, "id" | "created_at">>;

/**
 * Validate and normalize user input into an item's columns. Throws a plain
 * Error whose message is safe to show the user.
 */
function normalizeInput(input: ItemInput, { requireUrl = false } = {}): ItemPatch {
  const patch: ItemPatch = {};

  if (input.url !== undefined || requireUrl) {
    const url = String(input.url ?? "").trim();
    if (!url) throw new Error("A product URL is required.");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`"${url}" isn't a valid web address.`);
    }
    // The watcher fetches whatever this points at, so keep it to real web
    // pages — no file:, no data:, no localhost-poking via other schemes.
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("Only http(s) addresses can be watched.");
    }
    patch.url = url;
  }

  if (input.sizes !== undefined) {
    const sizes = parseSizes(input.sizes);
    if (!sizes.length) throw new Error("Pick at least one size to watch.");
    patch.sizes = sizes;
  }

  if (input.label !== undefined) {
    const label = String(input.label ?? "").trim();
    patch.label = label || null; // null → fall back to the derived label at read time
  }

  if (input.renotifyHours !== undefined) {
    const hours = Number(input.renotifyHours);
    patch.renotify_hours = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_RENOTIFY_HOURS;
  }

  // "Keep checking for" — stored alongside the deadline it implies, so the UI
  // can show both "2 days" and "stops in 40 hours" without re-deriving one.
  if (input.durationDays !== undefined) {
    const days = Number(input.durationDays);
    const durationDays = Number.isFinite(days) && days > 0 ? days : 0;
    patch.duration_days = durationDays;
    patch.expires_at = durationDays > 0 ? expiryFrom(durationDays) : null;
  }

  if (input.enabled !== undefined) {
    patch.enabled = Boolean(input.enabled);
  }

  return patch;
}

/** Turn a Postgres error into something worth showing someone. */
function fail(context: string, error: { message: string } | null): never {
  throw new Error(`${context}: ${error?.message ?? "unknown database error"}`);
}

/**
 * The whole watchlist, oldest first.
 *
 * `userId` is passed explicitly rather than left to row level security. With a
 * session client RLS would already do it; with the service-role key the sweep
 * uses, RLS is off, and without this filter a sweep would check every user's
 * items under one user's settings. Belt and braces, and the braces are the ones
 * that matter.
 */
export async function loadWatchlist(db: Db, userId: string): Promise<DisplayItem[]> {
  const { data, error } = await db
    .from("items")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .returns<ItemRow[]>();
  if (error) fail("Couldn't load your watchlist", error);
  return (data ?? []).map(forDisplay);
}

export async function getItem(db: Db, id: string): Promise<DisplayItem | null> {
  const { data, error } = await db
    .from("items")
    .select("*")
    .eq("id", id)
    .maybeSingle<ItemRow>();
  if (error) fail("Couldn't load that watch", error);
  return data ? forDisplay(data) : null;
}

export async function addItem(db: Db, userId: string, input: ItemInput): Promise<DisplayItem> {
  const patch = normalizeInput(input, { requireUrl: true });
  if (!patch.sizes?.length) throw new Error("Pick at least one size to watch.");

  const { data, error } = await db
    .from("items")
    .insert({
      user_id: userId,
      label: patch.label ?? null,
      url: patch.url!,
      sizes: patch.sizes,
      renotify_hours: patch.renotify_hours ?? DEFAULT_RENOTIFY_HOURS,
      duration_days: patch.duration_days ?? 0,
      expires_at: patch.expires_at ?? null,
      enabled: patch.enabled ?? true,
    })
    .select("*")
    .single<ItemRow>();
  if (error) fail("Couldn't save that watch", error);
  return forDisplay(data!);
}

export async function updateItem(db: Db, id: string, input: ItemInput): Promise<DisplayItem> {
  const patch = normalizeInput(input);
  const { data, error } = await db
    .from("items")
    .update(patch)
    .eq("id", id)
    .select("*")
    .maybeSingle<ItemRow>();
  if (error) fail("Couldn't update that watch", error);
  // Either it never existed or row level security hid someone else's. Same
  // answer to the person asking, and deliberately so.
  if (!data) throw new Error("That watch is no longer on the list.");
  return forDisplay(data);
}

/**
 * Remove a watch. Its status, alert state, checks and events go with it —
 * `on delete cascade` in the schema, rather than four deletes here that could
 * half-succeed.
 */
export async function removeItem(db: Db, id: string): Promise<void> {
  const { data, error } = await db.from("items").delete().eq("id", id).select("id");
  if (error) fail("Couldn't remove that watch", error);
  if (!data?.length) throw new Error("That watch is no longer on the list.");
}
