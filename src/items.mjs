// The dashboard's watchlist: multiple product+sizes entries, persisted as
// JSON. Separate from `.watch-state.json` (the single-item CLI's alert-dedupe
// memory) on purpose — this file is what you *want* to watch, that file is
// what the watcher last *saw*. Each item gets its own alert-state file (see
// `itemStatePath`) so multi-item state can't collide with each other or with
// the single-item CLI's state.

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_RENOTIFY_HOURS, DEFAULT_SIZES, DEFAULT_URL } from './index.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const WATCHLIST_PATH = resolve(scriptDir, '..', 'watchlist.json');
const STATE_DIR = resolve(scriptDir, '..', '.watch-state');

export function itemStatePath(id) {
  return resolve(STATE_DIR, `${id}.json`);
}

// Requests are handled one at a time by the HTTP server, but await points in
// a read-modify-write (load → mutate → save) leave a window for two of them
// to interleave and clobber each other. This chains every mutation onto the
// previous one so they run strictly in order — cheap, and enough for a
// single-user local tool.
let queue = Promise.resolve();
function serialized(fn) {
  const result = queue.then(fn, fn);
  queue = result.then(
    () => {},
    () => {},
  );
  return result;
}

async function readWatchlist() {
  try {
    const raw = await readFile(WATCHLIST_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === 'ENOENT') return null; // caller seeds the default
    throw error;
  }
}

async function writeWatchlist(items) {
  await writeFile(WATCHLIST_PATH, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
  return items;
}

/** A friendly-ish default label from the URL slug, e.g. ".../roots-x-big-apple-t-shirt-123.html" -> "Roots X Big Apple T Shirt". */
function deriveLabel(url) {
  try {
    const slug = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
    const words = slug
      .replace(/-\w{5,}\.html$/i, '')
      .replace(/\.html$/i, '')
      .split('-')
      .filter(Boolean);
    if (!words.length) return 'Roots item';
    return words.map((word) => word[0].toUpperCase() + word.slice(1)).join(' ');
  } catch {
    return 'Roots item';
  }
}

function parseSizes(input) {
  const list = Array.isArray(input) ? input : String(input ?? '').split(',');
  return list
    .map((size) => String(size).trim())
    .filter(Boolean);
}

function makeId(existing) {
  let id = randomUUID().replace(/-/g, '').slice(0, 8);
  while (existing.has(id)) id = randomUUID().replace(/-/g, '').slice(0, 8);
  return id;
}

/** Validates and normalizes user input into an item's editable fields. Throws a plain Error with a user-facing message on bad input. */
function normalizeInput(input, { requireUrl } = {}) {
  const patch = {};

  if (input.url !== undefined || requireUrl) {
    const url = String(input.url ?? '').trim();
    if (!url) throw new Error('A product URL is required.');
    try {
      new URL(url); // throws on anything unparsable — that's the check
    } catch {
      throw new Error(`"${url}" isn't a valid URL.`);
    }
    patch.url = url;
  }

  if (input.sizes !== undefined) {
    const sizes = parseSizes(input.sizes);
    if (!sizes.length) throw new Error('At least one size is required.');
    patch.sizes = sizes;
  }

  if (input.label !== undefined) {
    const label = String(input.label ?? '').trim();
    patch.label = label || null; // null -> fall back to the derived label at read time
  }

  if (input.renotifyHours !== undefined) {
    const hours = Number(input.renotifyHours);
    patch.renotifyHours = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_RENOTIFY_HOURS;
  }

  if (input.enabled !== undefined) {
    patch.enabled = Boolean(input.enabled);
  }

  return patch;
}

/** For display: an item always has a label, even if the user never set one. */
function withDisplayLabel(item) {
  return { ...item, label: item.label ?? deriveLabel(item.url) };
}

/** Loads the watchlist, seeding it with the CLI's single default item the first time there's nothing to load. */
export async function loadWatchlist() {
  const existing = await readWatchlist();
  if (existing) return existing.map(withDisplayLabel);

  const seeded = [
    {
      id: makeId(new Set()),
      label: null,
      url: DEFAULT_URL,
      sizes: parseSizes(DEFAULT_SIZES),
      renotifyHours: DEFAULT_RENOTIFY_HOURS,
      enabled: true,
      createdAt: new Date().toISOString(),
    },
  ];
  await mkdir(dirname(WATCHLIST_PATH), { recursive: true });
  await writeWatchlist(seeded);
  return seeded.map(withDisplayLabel);
}

export async function addItem(input) {
  return serialized(async () => {
    const items = (await readWatchlist()) ?? [];
    const patch = normalizeInput(input, { requireUrl: true });
    const item = {
      id: makeId(new Set(items.map((existing) => existing.id))),
      label: patch.label ?? null,
      url: patch.url,
      sizes: patch.sizes ?? parseSizes(DEFAULT_SIZES),
      renotifyHours: patch.renotifyHours ?? DEFAULT_RENOTIFY_HOURS,
      enabled: patch.enabled ?? true,
      createdAt: new Date().toISOString(),
    };
    await writeWatchlist([...items, item]);
    return withDisplayLabel(item);
  });
}

export async function updateItem(id, input) {
  return serialized(async () => {
    const items = (await readWatchlist()) ?? [];
    const index = items.findIndex((item) => item.id === id);
    if (index === -1) throw new Error(`No watched item with id "${id}".`);
    const patch = normalizeInput(input);
    const updated = { ...items[index], ...patch };
    items[index] = updated;
    await writeWatchlist(items);
    return withDisplayLabel(updated);
  });
}

export async function removeItem(id) {
  return serialized(async () => {
    const items = (await readWatchlist()) ?? [];
    const next = items.filter((item) => item.id !== id);
    if (next.length === items.length) throw new Error(`No watched item with id "${id}".`);
    await writeWatchlist(next);
  });
}
