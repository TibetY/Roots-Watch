#!/usr/bin/env node
//
// Multi-item HTML dashboard for the Roots stock watcher.
//
//   node src/server.mjs
//   npm run ui
//
// A tiny zero-dependency HTTP server (node:http, no Express) that serves the
// dashboard in public/dashboard.html and a small JSON API in front of the
// same checking/alerting logic the CLI uses (evaluateCheck, from index.mjs) —
// so the dashboard's dedupe, blind-run detection, and webhook notifications
// behave identically to `node src/index.mjs --watch`, just for a whole list
// of items instead of one.
//
// State lives in two places, kept deliberately separate:
//   watchlist.json          what you want watched — url, sizes, label, per item
//   .watch-state/<id>.json  what was last seen for that item (alert dedupe)
// Neither is committed (see .gitignore) — this is a local, single-user tool.

import { exec } from 'node:child_process';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildConfig, evaluateCheck, loadDotEnv } from './index.mjs';
import { addItem, itemStatePath, loadWatchlist, removeItem, updateItem } from './items.mjs';
import { hasAnyChannel, notifyAll, readNotifyConfig } from './notify.mjs';
import * as ui from './ui.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_PATH = resolve(scriptDir, '..', 'public', 'dashboard.html');
const ENV_PATH = resolve(scriptDir, '..', '.env');

const PORT = Number(process.env.ROOTS_WATCH_UI_PORT) || 4321;
// Local-only: this server fetches whatever URL an item has, so it has no
// business listening beyond localhost.
const HOST = '127.0.0.1';
const DEFAULT_INTERVAL_MINUTES = 10;
// Gap between items in a sweep, so a watchlist of several products doesn't
// hit roots.com all at once.
const STAGGER_MS = 4000;

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readJsonBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        rejectPromise(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data.trim()) return resolvePromise({});
      try {
        resolvePromise(JSON.parse(data));
      } catch {
        rejectPromise(new Error('Invalid JSON body'));
      }
    });
    req.on('error', rejectPromise);
  });
}

function openBrowser(url) {
  const command =
    process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(command, () => {}); // best-effort — a failed auto-open isn't worth surfacing, the URL is already printed
}

function normalizeSettingsInput(input) {
  const webhookUrl = String(input.webhookUrl ?? '').trim();
  if (webhookUrl) {
    try {
      new URL(webhookUrl);
    } catch {
      throw new Error(`"${webhookUrl}" isn't a valid URL.`);
    }
  }
  return { webhookUrl, webhookTopic: String(input.webhookTopic ?? '').trim() };
}

/**
 * Update ROOTS_WATCH_WEBHOOK / ROOTS_WATCH_WEBHOOK_TOPIC in .env in place —
 * same file the CLI reads, so a value set from the dashboard also applies to
 * `node src/index.mjs`. Existing lines (including commented-out examples)
 * and everything else in the file are left untouched; only an active
 * `KEY=...` line for one of these two keys gets replaced, and only if
 * neither exists yet does a new line get appended.
 */
async function upsertEnvFile(path, updates) {
  let contents = '';
  try {
    contents = await readFile(path, 'utf8');
  } catch {
    contents = ''; // no .env yet — fine, we're about to create one
  }

  const lines = contents.length ? contents.split('\n') : [];
  const remaining = new Set(Object.keys(updates));

  const next = lines.map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match && remaining.has(match[1])) {
      remaining.delete(match[1]);
      return `${match[1]}=${updates[match[1]]}`;
    }
    return line;
  });

  while (next.length && next[next.length - 1] === '') next.pop();
  for (const key of remaining) next.push(`${key}=${updates[key]}`);

  await writeFile(path, `${next.join('\n')}\n`, 'utf8');
}

/**
 * Everything that needs notifyConfig/baseConfig — the check runner, the
 * scheduler, and the API route handlers — built once at startup so they all
 * close over the same state instead of threading it through every call.
 */
function createApp(initialNotifyConfig, baseConfig) {
  const statusCache = new Map(); // item id -> latest evaluateCheck summary
  const inFlight = new Set(); // item ids currently being checked
  const control = { autoRun: true, intervalMinutes: DEFAULT_INTERVAL_MINUTES };
  let timer = null;
  let nextCheckAt = null;
  // Mutable, unlike baseConfig — the Settings panel can change this without a
  // restart. checkItem/runSweep close over the same binding, so a save takes
  // effect on the very next check.
  let notifyConfig = initialNotifyConfig;

  async function checkItem(item) {
    if (inFlight.has(item.id)) return statusCache.get(item.id) ?? null;
    inFlight.add(item.id);
    try {
      const config = {
        ...baseConfig,
        url: item.url,
        sizes: item.sizes,
        statePath: itemStatePath(item.id),
        renotifyHours: item.renotifyHours,
        dryRun: false,
        json: false,
      };
      const { summary } = await evaluateCheck(config, notifyConfig);
      statusCache.set(item.id, summary);
      return summary;
    } catch (error) {
      const summary = {
        checkedAt: new Date().toISOString(),
        error: `check failed: ${error.message ?? error}`,
        sizes: item.sizes.map((size) => ({ wanted: size, matchedLabel: null, status: 'unknown' })),
      };
      statusCache.set(item.id, summary);
      return summary;
    } finally {
      inFlight.delete(item.id);
    }
  }

  async function listItemsWithStatus() {
    const items = await loadWatchlist();
    return items.map((item) => ({
      ...item,
      status: statusCache.get(item.id) ?? null,
      checking: inFlight.has(item.id),
    }));
  }

  function scheduleNext(delayMs) {
    if (timer) clearTimeout(timer);
    nextCheckAt = Date.now() + delayMs;
    timer = setTimeout(runSweep, delayMs);
    timer.unref?.(); // a pending sweep should never be the reason Ctrl+C doesn't work
  }

  async function runSweep() {
    if (!control.autoRun) return;
    const items = await loadWatchlist();
    for (const item of items.filter((entry) => entry.enabled)) {
      if (!control.autoRun) break; // paused mid-sweep
      await checkItem(item).catch((error) => {
        console.error(`[${item.id}] check failed:`, error.stack ?? error);
      });
      await sleep(STAGGER_MS);
    }
    if (control.autoRun) {
      const jitterMs = Math.floor(Math.random() * 30_000);
      scheduleNext(control.intervalMinutes * 60_000 + jitterMs);
    }
  }

  function controlStatus() {
    return { autoRun: control.autoRun, intervalMinutes: control.intervalMinutes, nextCheckAt };
  }

  function setControl(patch) {
    let intervalChanged = false;
    if (patch.intervalMinutes !== undefined) {
      const minutes = Number(patch.intervalMinutes);
      if (Number.isFinite(minutes) && minutes > 0 && minutes !== control.intervalMinutes) {
        control.intervalMinutes = minutes;
        intervalChanged = true;
      }
    }

    if (patch.autoRun !== undefined) {
      const next = Boolean(patch.autoRun);
      if (next && !control.autoRun) {
        control.autoRun = true;
        scheduleNext(1000);
      } else if (!next && control.autoRun) {
        control.autoRun = false;
        if (timer) clearTimeout(timer);
        timer = null;
        nextCheckAt = null;
      }
    } else if (intervalChanged && control.autoRun) {
      scheduleNext(control.intervalMinutes * 60_000); // apply the new cadence right away
    }

    return controlStatus();
  }

  async function handleApi(req, res, url) {
    const { pathname } = url;
    const itemMatch = pathname.match(/^\/api\/items\/([^/]+)(\/check)?$/);

    if (pathname === '/api/items' && req.method === 'GET') {
      return sendJson(res, 200, await listItemsWithStatus());
    }

    if (pathname === '/api/items' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const item = await addItem(body);
      checkItem(item).catch(() => {}); // fire-and-forget so "add" responds without waiting on a full page fetch
      return sendJson(res, 201, { ...item, status: null, checking: true });
    }

    if (itemMatch && !itemMatch[2] && req.method === 'PATCH') {
      const id = itemMatch[1];
      const body = await readJsonBody(req);
      const item = await updateItem(id, body);
      if (body.url !== undefined || body.sizes !== undefined) {
        checkItem(item).catch(() => {});
      }
      return sendJson(res, 200, { ...item, status: statusCache.get(id) ?? null, checking: inFlight.has(id) });
    }

    if (itemMatch && !itemMatch[2] && req.method === 'DELETE') {
      const id = itemMatch[1];
      await removeItem(id);
      statusCache.delete(id);
      await unlink(itemStatePath(id)).catch(() => {});
      return sendJson(res, 200, { ok: true });
    }

    if (itemMatch && itemMatch[2] && req.method === 'POST') {
      const id = itemMatch[1];
      const items = await loadWatchlist();
      const item = items.find((entry) => entry.id === id);
      if (!item) return sendJson(res, 404, { error: `No watched item with id "${id}".` });
      const status = await checkItem(item);
      return sendJson(res, 200, { ...item, status, checking: false });
    }

    if (pathname === '/api/check-all' && req.method === 'POST') {
      const items = (await loadWatchlist()).filter((item) => item.enabled);
      for (const item of items) {
        await checkItem(item);
        await sleep(STAGGER_MS);
      }
      return sendJson(res, 200, await listItemsWithStatus());
    }

    if (pathname === '/api/control' && req.method === 'GET') {
      return sendJson(res, 200, controlStatus());
    }

    if (pathname === '/api/control' && req.method === 'POST') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, setControl(body));
    }

    if (pathname === '/api/settings' && req.method === 'GET') {
      return sendJson(res, 200, { ...notifyConfig, hasChannel: hasAnyChannel(notifyConfig) });
    }

    if (pathname === '/api/settings' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const next = normalizeSettingsInput(body);
      notifyConfig = next; // takes effect on the next check immediately
      await upsertEnvFile(ENV_PATH, {
        ROOTS_WATCH_WEBHOOK: next.webhookUrl,
        ROOTS_WATCH_WEBHOOK_TOPIC: next.webhookTopic,
      });
      return sendJson(res, 200, { ...next, hasChannel: hasAnyChannel(next) });
    }

    if (pathname === '/api/settings/test' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const candidate = normalizeSettingsInput(body);
      if (!candidate.webhookUrl) throw new Error('A webhook URL is required to send a test.');
      const [result] = await notifyAll(
        candidate,
        'This is a test notification from your Roots stock watch dashboard. 🌿 If this arrived, alerts are wired up correctly.',
        { title: 'Roots stock watch — test' },
      );
      return sendJson(res, 200, result ?? { channel: 'webhook', ok: false, detail: 'No channel configured' });
    }

    return sendJson(res, 404, { error: 'Not found' });
  }

  function start() {
    if (control.autoRun) scheduleNext(1000);
  }

  return { handleApi, start };
}

async function main() {
  await loadDotEnv(resolve(scriptDir, '..', '.env'));
  const notifyConfig = readNotifyConfig(process.env);
  const baseConfig = buildConfig([], process.env);

  if (!hasAnyChannel(notifyConfig)) {
    console.warn(
      ui.yellow(
        "Warning: no notification channel configured — the dashboard will still show live status, but nothing will be pushed to your phone. Set ROOTS_WATCH_WEBHOOK in .env if you want that.",
      ),
    );
  }

  const initialItems = await loadWatchlist();
  console.log(ui.dim(`Loaded ${initialItems.length} watched item${initialItems.length === 1 ? '' : 's'}.`));

  const app = createApp(notifyConfig, baseConfig);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

      if (url.pathname === '/' && req.method === 'GET') {
        const html = await readFile(DASHBOARD_PATH, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        await app.handleApi(req, res, url);
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      const status = /required|invalid|isn't a valid|No watched item/i.test(String(error.message)) ? 400 : 500;
      if (status === 500) console.error(error.stack ?? error);
      sendJson(res, status, { error: error.message ?? String(error) });
    }
  });

  server.listen(PORT, HOST, () => {
    const dashboardUrl = `http://${HOST}:${PORT}`;
    console.log(ui.renderBanner());
    console.log(`${ui.EYE} Dashboard running at ${ui.underline(dashboardUrl)}`);
    console.log(ui.dim('  Ctrl+C to stop.'));
    if (!process.env.ROOTS_WATCH_NO_OPEN) openBrowser(dashboardUrl);
    app.start();
  });
}

main().catch((error) => {
  console.error(error.stack ?? error);
  process.exitCode = 1;
});
