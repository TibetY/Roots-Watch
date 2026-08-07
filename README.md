# roots-stock-watch

Watches a [roots.com](https://www.roots.com) product page for specific sizes and
sends a push notification with a buy link the moment one comes back in stock.

Default target: **Roots x Big Apple T-Shirt**, colour `12B`, **sizes 3 and 5**.

```
https://www.roots.com/ca/en/roots-x-big-apple-t-shirt-27190104.html?dwvar_27190104_color=12B
```

The watcher itself has **no dependencies** — clone it and run it with Node 18+.
The one package in `package.json` is vitest, for the tests.

## Quick start

```bash
# HTML dashboard — watch as many products as you want, opens in your browser.
npm run ui

# Interactive terminal menu — a ROOTS logo, then choose what to run.
npm start

# One check, nothing sent — just prints what it sees.
node src/index.mjs --once --dry-run

# Keep checking every 30 minutes in this terminal.
npm run watch
```

## HTML dashboard

`npm run ui` starts a small local server (opens `http://127.0.0.1:4321` in your
browser automatically) for watching **more than one product at once** — the
CLI and terminal menu are built around a single URL/sizes pair; the dashboard
is the multi-item version of the same watcher.

- **Add** as many product URLs as you want, each with its own sizes and a
  label. Every item gets its own alert-dedupe state, so they don't interfere
  with each other or with the single-item CLI.
- Each card shows size availability as coloured pills — **green** for in
  stock, **red** for sold out, gold for unknown — plus the product image,
  price, and a pulsing **Buy now** button the moment something's available.
- One **auto-run** toggle and interval (5/15/30 min, 1/6 hr, or custom)
  controls the whole watchlist; a staggered background sweep checks each
  enabled item in turn so a big list doesn't hit roots.com all at once.
  Pause/resume individual items, or trigger **Check now** / **Check all** on
  demand.
- **⚙ Settings** covers both alert channels in one place:
  - **Push notifications** — set the webhook URL and (for ntfy) topic right
    in the browser, no `.env` editing required. **Send test** fires one
    immediately so you can confirm it actually arrives before waiting on a
    real restock. Saving here writes `ROOTS_WATCH_WEBHOOK` /
    `ROOTS_WATCH_WEBHOOK_TOPIC` into `.env` in place — it's the same setting
    the CLI reads, so this doubles as the easiest way to set it up in the
    first place.
  - **Browser alerts** — native OS notifications from the dashboard tab
    while it's open, on top of push notifications, not instead of them. A
    one-click toggle handles the permission prompt.
  - The header line always shows a quick summary (`push + browser`, `push`,
    or `no alerts set up`) without opening the dialog.
- The watchlist lives in `watchlist.json` at the repo root (gitignored, like
  `.watch-state.json`) — a plain JSON file you can also hand-edit. It's seeded
  with the CLI's single default item the first time there's nothing there.

The server binds to `127.0.0.1` only (not your network). Change the port with
`ROOTS_WATCH_UI_PORT`, or set `ROOTS_WATCH_NO_OPEN=1` to skip the automatic
browser launch. Leave the terminal it's running in open — Ctrl+C there stops
it, same as any other long-running dev server.

## Interactive CLI

Running the watcher with no flags at all, in a real terminal, opens a small
menu instead of just checking once:

```
  1  Start          configure & run a check
  2  Settings       url · sizes · notifications
  Q  Quit
```

**Start** opens a run form — arrow keys move between fields, ←/→ change a
value, Enter starts:

```
  Auto-run       Yes   No
  Frequency      5min  15min  30min  1hr  6hr  Custom
  Duration       Forever  1 day  2 days  7 days
```

Duration is how long the auto-run session keeps going before it stops itself
and drops back to the menu — `Forever` runs until you cancel it. Once it's
running, **Ctrl+C cancels the auto-run and returns to the menu — it does not
exit the CLI.** (At the menu itself, Ctrl+C does quit.)

**Settings** shows the current URL, sizes, and whether a notification channel
is configured, and lets you edit URL/sizes for the session (these edits don't
touch `.env`).

This only engages for a bare invocation (`node src/index.mjs` / `npm start` /
`roots-watch`, no flags) in a TTY — anything scripted, including every command
below and the GitHub Actions workflow, keeps working exactly as documented and
never sees the menu. `npm link` installs the `roots-watch` command if you'd
rather not type `node src/index.mjs`.

Colour throughout (menu and scripted output alike) respects [`NO_COLOR`](https://no-color.org)
and auto-disables when output isn't a terminal (e.g. piped to a file).

## Setting up notifications

Alerts go out through a generic JSON webhook. Configure it in the environment
before running the watcher — or, if you're using the [HTML dashboard](#html-dashboard),
its **⚙ Settings** panel does this same thing from the browser, test button
included.

```bash
cp .env.example .env   # then fill it in — .env is gitignored
```

`ROOTS_WATCH_WEBHOOK` can be any URL that accepts a JSON POST — Pushover, ntfy,
Slack, Discord, or an IFTTT/Zapier hook wired to SMS. The payload includes
`message`, `text` and `content`, so most services work without a translation
step.

The recommended default is **ntfy.sh**: free, no account, and push notifications
land in seconds. Install the [ntfy app](https://ntfy.sh) and:

```bash
ROOTS_WATCH_WEBHOOK=https://ntfy.sh
ROOTS_WATCH_WEBHOOK_TOPIC=<your-topic>
```

ntfy only reads JSON fields when the topic is in the request body — posting
straight to `https://ntfy.sh/<topic>` makes it treat the whole JSON blob as the
literal message text, which is why `ROOTS_WATCH_WEBHOOK` stays the bare origin
and the topic is a separate variable. Subscribe to that same topic in the app to
get the push. ntfy topics are public and unauthenticated by default, so pick
something long and random rather than a plain word — anyone who knows the topic
name can read or publish to it, which matters for a limited restock you don't
want to share.

With nothing set the watcher still runs and prints results; it just has nowhere
to send them, and says so on startup.

## Running it every 5 minutes

`.github/workflows/watch.yml` runs the check on GitHub Actions every 5 minutes,
so nothing needs to stay open on your machine. Put the webhook values in
**repository secrets** (Settings → Secrets and variables → Actions) — never
commit a topic name or webhook URL, since both act as credentials.

Scheduled workflows only fire from the repository's **default branch**, so the
workflow has to be on `main` to run at all.

### Why the cron doesn't set the cadence

`schedule` is best-effort, and GitHub sheds a lot of it under load. This repo
ran a 10-minute cron and got **30 of the 321 runs it asked for** over two days —
a median of 1.6 hours between checks, worst case 3.6 hours, firing at scattered
minutes that ignored the cron entirely. Raising the frequency to `*/5` makes
that worse rather than better: high-frequency schedules are the first thing to
get dropped.

So cron doesn't set the pace here. It only *starts* a session, twice an hour,
and the watcher paces its own 5-minute checks from inside one long-running job.
A dropped tick now costs one session start instead of one check. Sessions run
55 minutes, and `concurrency` keeps at most one running with one queued behind
it, so the next session starts as soon as the current one ends and coverage
stays roughly continuous.

The public-repo Actions allowance is what makes this affordable — a job running
almost continuously would be expensive against a private repo's minute budget.

To run it locally instead, `npm run watch` keeps a terminal loop going, or use
cron — the local cron daemon is reliable, so there one line per check is fine:

```cron
*/5 * * * * cd /path/to/roots-stock-watch && /usr/bin/node src/index.mjs --once >> /tmp/roots-watch.log 2>&1
```

## How it decides something is in stock

roots.com runs on Salesforce Commerce Cloud, which exposes the same JSON
endpoint the product page itself calls when you click a size swatch
(`Product-Variation`). Each size comes back with a `selectable` flag — the
site's own answer to "can this go in the cart right now" — and that is what the
watcher trusts. The endpoint URL is read out of the page rather than hard-coded,
so a storefront or locale change doesn't break it.

If that call fails it falls back to reading the size swatches out of the HTML
and flags the result as low confidence; alerts from that path carry a
"double-check before buying" note.

Every layer is allowed to answer **unknown**. A size that can't be read is never
reported as sold out, because a quiet watcher and a sold-out shirt look
identical from the outside — after two hours of unreadable checks it sends
*itself* an alert, so a site redesign or a bot wall doesn't cost you the
restock. That threshold is wall-clock time, not a number of checks, so changing
the interval doesn't quietly change what it means.

Alerts are deduped through `.watch-state.json`: you get one notification when a
size flips to in-stock, not one every half hour while it stays there.

## Options

| Flag | Meaning |
| --- | --- |
| `--url <url>` | Product page, including the `dwvar_..._color` parameter. |
| `--sizes 3,5` | Sizes to watch. `3` also matches `3T` / `3 (3T)`. |
| `--watch` | Keep running instead of checking once. |
| `--interval 30` | Minutes between checks in `--watch` mode. |
| `--max-minutes 55` | Stop `--watch` after roughly this long. Default: run forever. |
| `--renotify-hours 6` | While a size stays in stock, re-alert at most this often. |
| `--browser` | Render with Playwright (`npm i -D playwright`) if plain fetches get blocked. |
| `--dump page.html` | Save the fetched HTML — useful when parsing looks wrong. |
| `--json` | Machine-readable output. |
| `--dry-run` | Do everything except send. |

Exit codes: `0` nothing in stock, `10` something is, `20` couldn't tell.

## Watching something else

Any Roots product page works — copy the URL with the colour swatch selected:

```bash
node src/index.mjs --once --url 'https://www.roots.com/ca/en/<product>.html?dwvar_<id>_color=<code>' --sizes M,L
```

Set `ROOTS_WATCH_URL` / `ROOTS_WATCH_SIZES` (as repository *variables* on
Actions) to change the default target without editing the workflow.
`ROOTS_WATCH_INTERVAL` changes the check interval the same way.

## If it stops working

Run `node src/index.mjs --once --dump page.html --json` and look at `source`:

- `variation-api` — the good path.
- `html` — the endpoint call failed; parsing is working off markup.
- `none` — the page couldn't be fetched at all. Check `page.html` for a
  bot-check or CAPTCHA page; `--browser` usually gets past those.

`npm test` covers the parsers against fixtures shaped like Salesforce Commerce
Cloud output, so it will tell you whether a change broke the logic — but only
the real page can tell you whether the site changed shape underneath it.

## Layout

```
src/index.mjs      CLI entry point, checking/alerting logic (evaluateCheck), state
src/parse.mjs      All page parsing — pure functions, no I/O
src/notify.mjs     Webhook delivery (ntfy, Slack, Discord, Pushover, ...)
src/ui.mjs         Colours, the ROOTS wordmark, screen/box primitives
src/tui.mjs        The interactive terminal menu (see "Interactive CLI" above)
src/items.mjs      The dashboard's watchlist store (watchlist.json CRUD)
src/server.mjs     The dashboard's HTTP server + scheduler (see "HTML dashboard" above)
public/dashboard.html  The dashboard's frontend — plain HTML/CSS/JS, no build step
test/              Fixture-based tests for the parsers
```

`evaluateCheck` (in `index.mjs`) is the shared core — one check, alert
dedupe, and notification — that both the CLI's `runCheck` (adds console
output) and the dashboard's `checkItem` (adds the JSON API) build on, so
"in stock" means the same thing and fires the same webhook everywhere.
