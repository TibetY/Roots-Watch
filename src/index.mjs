#!/usr/bin/env node
//
// Roots product stock watcher.
//
//   node src/index.mjs --once
//   node src/index.mjs --watch --interval 30
//
// Checks a roots.com product page for specific sizes and sends a push
// notification with a buy link the moment one of them becomes available.
// Defaults are set for the shirt this was written for (Roots x Big Apple tee,
// colour 12B, sizes 3 & 5) and can be overridden by flag or environment
// variable.
//
// Design notes that matter if you come back to this later:
//
//   * The check is layered. SFRA's Product-Variation JSON is the trusted
//     source; markup scraping is the fallback; JSON-LD fills in name/price.
//     See parse.mjs for why.
//   * State lives in a JSON file so a restock doesn't produce a notification
//     on every check while it lasts. Alerts fire on the out-of-stock ->
//     in-stock edge, then at most once per --renotify-hours while it stays
//     in stock.
//   * If the parser goes blind (site redesign, bot wall, network failure) the
//     watcher says so rather than sitting quietly on "no news". Silence is
//     indistinguishable from "still sold out", which is the one failure mode
//     that loses you the shirt.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  IN_STOCK,
  OUT_OF_STOCK,
  UNKNOWN,
  buildVariationUrl,
  discoverVariationEndpoint,
  extractJsonLd,
  extractSizesFromHtml,
  extractSizesFromVariationJson,
  matchWantedSizes,
  parseProductUrl,
  summarizeJsonLd,
} from './parse.mjs';
import { hasAnyChannel, notifyAll, readNotifyConfig } from './notify.mjs';

const DEFAULT_URL =
  'https://www.roots.com/ca/en/roots-x-big-apple-t-shirt-27190104.html?dwvar_27190104_color=12B';
const DEFAULT_SIZES = '3,5';
const DEFAULT_INTERVAL_MINUTES = 30;
const DEFAULT_RENOTIFY_HOURS = 6;
// Two hours of consecutive blindness before we bother the user about it. Short
// enough to catch a real breakage the same morning, long enough to ride out a
// transient 403 or a maintenance window. Checks run every 10 minutes (locally
// and on the GitHub Actions cron), so that's 12 consecutive misses.
const BLIND_RUNS_BEFORE_ALERT = 12;

const scriptDir = dirname(fileURLToPath(import.meta.url));

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-CA,en;q=0.9',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
};

function parseArgs(argv) {
  const args = { flags: new Set(), values: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args.values[key] = next;
      i += 1;
    } else {
      args.flags.add(key);
    }
  }
  return args;
}

function buildConfig(argv, env) {
  const args = parseArgs(argv);
  const sizesRaw = args.values.sizes ?? env.ROOTS_WATCH_SIZES ?? DEFAULT_SIZES;

  return {
    url: args.values.url ?? env.ROOTS_WATCH_URL ?? DEFAULT_URL,
    sizes: sizesRaw
      .split(',')
      .map((size) => size.trim())
      .filter(Boolean),
    watch: args.flags.has('watch'),
    intervalMinutes: Number(args.values.interval ?? env.ROOTS_WATCH_INTERVAL ?? DEFAULT_INTERVAL_MINUTES),
    renotifyHours: Number(args.values['renotify-hours'] ?? env.ROOTS_WATCH_RENOTIFY_HOURS ?? DEFAULT_RENOTIFY_HOURS),
    statePath: resolve(args.values.state ?? env.ROOTS_WATCH_STATE ?? resolve(scriptDir, '..', '.watch-state.json')),
    useBrowser: args.flags.has('browser') || env.ROOTS_WATCH_BROWSER === '1',
    dumpPath: args.values.dump ?? null,
    json: args.flags.has('json'),
    dryRun: args.flags.has('dry-run'),
    help: args.flags.has('help'),
  };
}

const USAGE = `Roots stock watcher

Usage:
  node src/index.mjs [options]

Options:
  --url <url>              Product page URL (with the dwvar colour param).
  --sizes <a,b>            Comma-separated sizes to watch. Default: ${DEFAULT_SIZES}
  --watch                  Keep running and re-check on an interval.
  --interval <minutes>     Minutes between checks in --watch mode. Default: ${DEFAULT_INTERVAL_MINUTES}
  --renotify-hours <n>     Re-send while still in stock, at most this often. Default: ${DEFAULT_RENOTIFY_HOURS}
  --state <path>           Where to persist alert state.
  --browser                Render with Playwright instead of a plain fetch.
  --dump <path>            Save the fetched HTML for debugging.
  --json                   Print the result as JSON.
  --dry-run                Do everything except actually send the alert.
  --help                   Show this message.

Environment:
  ROOTS_WATCH_WEBHOOK, ROOTS_WATCH_WEBHOOK_TOPIC  -> notifications (ntfy, Slack, Discord, Pushover, ...)

Exit codes:
  0  checked successfully, nothing in stock
  10 at least one watched size is in stock
  20 could not determine availability
`;

/** Fetch with a couple of retries — a single blip shouldn't skip a slot. */
async function fetchWithRetry(url, { attempts = 3, timeoutMs = 30_000, headers = BROWSER_HEADERS } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(2000 * 2 ** (attempt - 1));
      }
    }
  }
  throw lastError;
}

/**
 * Render the page in a real browser.
 *
 * Only used behind --browser, and Playwright is imported dynamically so it
 * stays an optional dependency: the plain-fetch path needs nothing installed.
 * Worth reaching for if Roots starts serving a bot-check page to bare fetches.
 */
async function fetchWithBrowser(url) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error('--browser needs Playwright: npm i -D playwright && npx playwright install chromium');
  }

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      userAgent: BROWSER_HEADERS['User-Agent'],
      locale: 'en-CA',
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    // Size swatches are server-rendered, but the availability classes get
    // reconciled by the PDP's own JS shortly after load.
    await page.waitForTimeout(3000);
    return await page.content();
  } finally {
    await browser.close();
  }
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Load a local .env file into process.env, if there is one.
 *
 * Hand-rolled rather than pulling in dotenv, so the watcher keeps its "clone
 * and run, nothing to install" property. Existing environment variables always
 * win, which is what makes this a no-op on GitHub Actions, where the real
 * values arrive as secrets.
 */
async function loadDotEnv(path) {
  let contents;
  try {
    contents = await readFile(path, 'utf8');
  } catch {
    return;
  }

  for (const line of contents.split('\n')) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    process.env[key] = rawValue.trim().replace(/^(['"])(.*)\1$/, '$2');
  }
}

async function loadState(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return { sizes: {}, blindRuns: 0, blindAlertSent: false };
  }
}

async function saveState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/**
 * Run one availability check.
 *
 * @returns {Promise<{results: Array, confidence: string, productName: string|null,
 *                    price: unknown, currency: string|null, error: string|null,
 *                    source: string, allSizes: Array}>}
 */
export async function checkOnce(config) {
  const { origin, pid, color } = parseProductUrl(config.url);

  if (!pid) {
    return blindResult(config, 'could not extract the product id from the URL');
  }

  let html;
  try {
    html = config.useBrowser ? await fetchWithBrowser(config.url) : await fetchWithRetry(config.url);
  } catch (error) {
    return blindResult(config, `fetching the product page failed: ${error.message ?? error}`);
  }

  if (config.dumpPath) {
    await writeFile(resolve(config.dumpPath), html, 'utf8');
  }

  const jsonLd = summarizeJsonLd(extractJsonLd(html));

  // Preferred path: ask SFRA directly.
  let reading = null;
  let source = 'html';
  const endpoint = discoverVariationEndpoint(html, origin);
  if (endpoint) {
    try {
      const variationUrl = buildVariationUrl(endpoint, { pid, color });
      const payload = await fetchWithRetry(variationUrl, {
        attempts: 2,
        headers: { ...BROWSER_HEADERS, Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      });
      reading = extractSizesFromVariationJson(JSON.parse(payload));
      if (reading) source = 'variation-api';
    } catch {
      // Fall through to markup scraping — noted in `source` on the result.
    }
  }

  if (!reading) {
    reading = extractSizesFromHtml(html);
  }

  const results = matchWantedSizes(reading.sizes, config.sizes);

  return {
    results,
    allSizes: reading.sizes,
    confidence: reading.confidence,
    source,
    productName: reading.productName ?? jsonLd?.name ?? null,
    price: jsonLd?.price ?? null,
    currency: jsonLd?.currency ?? null,
    error: null,
  };
}

function blindResult(config, message) {
  return {
    results: config.sizes.map((size) => ({ wanted: String(size), matchedLabel: null, status: UNKNOWN })),
    allSizes: [],
    confidence: 'low',
    source: 'none',
    productName: null,
    price: null,
    currency: null,
    error: message,
  };
}

/** Deep link that lands on the page with colour and size already chosen. */
function buyLink(config, size) {
  const url = new URL(config.url);
  const { pid } = parseProductUrl(config.url);
  if (pid && size) url.searchParams.set(`dwvar_${pid}_size`, size);
  return url.toString();
}

function sizeListText(entries) {
  return entries.map((entry) => entry.matchedLabel ?? entry.wanted).join(' & ');
}

function formatAlert(config, report, inStock) {
  const name = report.productName ?? 'Roots item';
  const sizeList = sizeListText(inStock);
  const priceBit = report.price ? ` (${report.currency === 'CAD' ? '$' : ''}${report.price})` : '';
  const caveat = report.confidence === 'low' ? '\n(read from page markup — double-check before buying)' : '';
  const link = buyLink(config, inStock[0]?.matchedLabel ?? inStock[0]?.wanted);

  return `IN STOCK: ${name}${priceBit} — size ${sizeList}\n${link}${caveat}`;
}

/** Notification title — names the size so it's visible without opening the alert. */
function alertTitle(inStock) {
  return `Roots in stock — size ${sizeListText(inStock)}`;
}

function describe(report) {
  const parts = report.results.map((entry) => {
    const label = entry.matchedLabel ? `${entry.wanted} (${entry.matchedLabel})` : entry.wanted;
    const symbol = entry.status === IN_STOCK ? 'IN STOCK' : entry.status === OUT_OF_STOCK ? 'sold out' : 'unknown';
    return `size ${label}: ${symbol}`;
  });
  return parts.join(', ');
}

async function runCheck(config, notifyConfig) {
  const startedAt = new Date();
  const report = await checkOnce(config);
  const state = await loadState(config.statePath);
  const nowMs = startedAt.getTime();

  const inStock = report.results.filter((entry) => entry.status === IN_STOCK);
  const allUnknown = report.results.every((entry) => entry.status === UNKNOWN);

  // Alert on the transition into stock, then only every --renotify-hours so a
  // long restock doesn't turn into a text every half hour.
  const shouldAlert = inStock.filter((entry) => {
    const previous = state.sizes[entry.wanted] ?? {};
    if (previous.status !== IN_STOCK) return true;
    const elapsedHours = (nowMs - (previous.notifiedAt ?? 0)) / 3_600_000;
    return elapsedHours >= config.renotifyHours;
  });

  let notifications = [];
  if (shouldAlert.length && !config.dryRun) {
    notifications = await notifyAll(notifyConfig, formatAlert(config, report, shouldAlert), {
      title: alertTitle(shouldAlert),
      product: report.productName,
      sizes: shouldAlert.map((entry) => entry.matchedLabel ?? entry.wanted),
      url: buyLink(config, shouldAlert[0]?.matchedLabel ?? shouldAlert[0]?.wanted),
      confidence: report.confidence,
    });
  }

  // Track "we couldn't tell" separately from "sold out" so a broken parser
  // surfaces as its own alert instead of looking like a quiet no-restock.
  state.blindRuns = allUnknown ? (state.blindRuns ?? 0) + 1 : 0;
  if (!allUnknown) state.blindAlertSent = false;

  if (state.blindRuns >= BLIND_RUNS_BEFORE_ALERT && !state.blindAlertSent && !config.dryRun) {
    const reason = report.error ?? 'the size swatches were not found on the page';
    await notifyAll(
      notifyConfig,
      `Roots watcher can't read the page (${state.blindRuns} checks in a row): ${reason}\n${config.url}`,
      { kind: 'watcher-error', url: config.url },
    );
    state.blindAlertSent = true;
  }

  for (const entry of report.results) {
    const previous = state.sizes[entry.wanted] ?? {};
    const notified = shouldAlert.some((alerted) => alerted.wanted === entry.wanted);
    state.sizes[entry.wanted] = {
      status: entry.status,
      seenAt: startedAt.toISOString(),
      notifiedAt: notified ? nowMs : previous.notifiedAt ?? null,
    };
  }

  await saveState(config.statePath, state);

  const summary = {
    checkedAt: startedAt.toISOString(),
    url: config.url,
    product: report.productName,
    source: report.source,
    confidence: report.confidence,
    error: report.error,
    sizes: report.results,
    alerted: shouldAlert.map((entry) => entry.wanted),
    notifications,
  };

  if (config.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    const stamp = startedAt.toLocaleString('en-CA', { timeZone: 'America/Toronto' });
    console.log(`[${stamp}] ${describe(report)} — via ${report.source} (${report.confidence} confidence)`);
    if (report.error) console.error(`  ! ${report.error}`);
    if (report.allSizes.length) {
      console.log(`  sizes on page: ${report.allSizes.map((size) => size.label).join(', ')}`);
    }
    for (const note of notifications) {
      const target = note.target ? ` -> ${note.target}` : '';
      console.log(`  ${note.ok ? 'sent' : 'FAILED'} via ${note.channel}${target}${note.detail ? `: ${note.detail}` : ''}`);
    }
    if (shouldAlert.length && config.dryRun) {
      console.log(`  [dry run] would have sent: ${formatAlert(config, report, shouldAlert).replace(/\n/g, ' ')}`);
    }
  }

  if (inStock.length) return 10;
  if (allUnknown) return 20;
  return 0;
}

async function main() {
  // Before buildConfig, since .env can also set ROOTS_WATCH_* options.
  await loadDotEnv(resolve(scriptDir, '..', '.env'));

  const config = buildConfig(process.argv.slice(2), process.env);
  if (config.help) {
    console.log(USAGE);
    return 0;
  }

  const notifyConfig = readNotifyConfig(process.env);
  if (!hasAnyChannel(notifyConfig) && !config.dryRun) {
    console.warn(
      'Warning: no notification channel configured — results will only be printed here.\n' +
        '  Set ROOTS_WATCH_WEBHOOK (and ROOTS_WATCH_WEBHOOK_TOPIC for ntfy) to get alerts.',
    );
  }

  console.log(`Watching ${config.url}`);
  console.log(`Sizes: ${config.sizes.join(', ')}${config.watch ? ` — every ${config.intervalMinutes} min` : ''}`);

  if (!config.watch) {
    return runCheck(config, notifyConfig);
  }

  for (;;) {
    try {
      await runCheck(config, notifyConfig);
    } catch (error) {
      // The loop outliving any single failure is the whole point of the loop.
      console.error(`Check failed: ${error.stack ?? error}`);
    }
    // A little jitter so we're not hitting the origin on an exact cadence.
    const jitterMs = Math.floor(Math.random() * 60_000);
    await sleep(config.intervalMinutes * 60_000 + jitterMs);
  }
}

// Only run when invoked directly, so the check can also be imported.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code ?? 0;
    })
    .catch((error) => {
      console.error(error.stack ?? error);
      process.exitCode = 1;
    });
}
