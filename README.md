# restock

Watches shop product pages for the sizes you want and pushes an alert with a
buy link the moment one is back in stock.

Built as a [React Router v8](https://reactrouter.com) (framework mode) app in
TypeScript — the successor to Remix, same route-module/loader/action model.
Written against [roots.com](https://www.roots.com), which runs on Salesforce
Commerce Cloud; any SFRA storefront should work.

```bash
npm install
npm run dev          # http://localhost:5173
```

## What it does

Four screens, styled with the **Modernist** design system — off-white ground,
one loud red accent, square corners, heavy rules, Archivo.

### Watching

One row per watch. Size availability reads as tags: filled red for in stock,
grey for sold out, outlined for "couldn't tell". A watch that comes back in
stock lifts its row onto a tinted background and raises a full-bleed banner
with a direct buy link.

A watcher that has gone **blind** says so in its own words rather than looking
like a quiet no-restock — because a silent watcher and a sold-out shelf look
identical from the outside, and that's the one failure mode that loses you the
thing.

### Add an item

Paste a product page, press **Find it**, and the server reads the page once and
shows you what it found: name, image, price, and **every size the page actually
lists** — so you pick from the real thing instead of typing size names and
hoping they match. Then choose how long to keep watching and save, optionally
paused.

### Settings

The ntfy setup as a numbered walkthrough: install the app, point the watcher at
your server and topic, then **Send a test** to prove it arrives before you wait
on a real restock. Saving writes to `.env`. Check cadence, a running/paused
switch, and browser notifications live here too.

### Console

A real terminal for the watcher, for when clicking is slower than typing. Every
command runs the same server code the buttons do — `check` really fetches the
page and really fires your push; `sizes` really rewrites the watchlist. `ls`
numbers your watches and the other commands take that number:

```
ls                    every watch, one line each
status                cadence, alert channel, counters
check        check 1  check everything, or just watch #1
sizes 1 3,5           set the sizes on watch #1
interval 5m           1m · 5m · 30m · 1h
for 1 2d              1d · 2d · 1w · forever
pause 1      resume 1
rm 1                  stop watching and remove
notify test           send a test push
help         clear
```

Arrow keys walk your command history.

## How it decides something is in stock

SFRA exposes the same JSON endpoint the product page itself calls when you
click a size swatch (`Product-Variation`). Each size comes back with a
`selectable` flag — the site's own answer to "can this go in a cart right now"
— and that is what the watcher trusts. The endpoint URL is read out of the page
rather than hard-coded, so a storefront or locale change doesn't break it.

If that call fails it falls back to reading the size swatches out of the HTML
and flags the result low confidence; alerts from that path carry a
"double-check before buying" note.

Every layer is allowed to answer **unknown**. A size that can't be read is
never reported as sold out. After two hours of unreadable checks the watcher
sends *itself* an alert, so a site redesign or a bot wall doesn't cost you the
restock.

Alerts are deduped per item: you get one notification when a size flips to
in-stock, then at most one every 6 hours while it stays there.

## Setting up alerts

Use the Settings screen — it writes `ROOTS_WATCH_WEBHOOK` and
`ROOTS_WATCH_WEBHOOK_TOPIC` into `.env` for you. Or copy `.env.example` and
fill it in by hand.

The recommended default is **ntfy.sh**: free, no account, push lands in
seconds. Set the webhook to the bare origin (`https://ntfy.sh`) and put your
topic in the topic field — ntfy only parses JSON fields when you POST to its
origin with `topic` in the body, not when posting straight to `/<topic>`.

ntfy topics are public and unauthenticated, so **pick something long and
random**. Anyone who knows the topic name can read or publish to it, which
matters for a limited restock you don't want to share.

Any JSON webhook works — Slack, Discord, Pushover, an IFTTT/Zapier hook wired
to SMS. The payload includes `message`, `text` and `content`, so most services
work without a translation step.

## Running it for real

Checking happens in a background loop inside the server process, so alerts fire
whether or not a browser tab is open — but the server has to be up.

```bash
npm run build
npm start            # http://localhost:3000, honours PORT
```

Leave that running somewhere that stays on. There's no scheduled-CI mode: the
previous version polled from GitHub Actions, which is gone along with the CLI.
If you want checks without a machine of your own running, deploy the app —
it's a standard React Router server (there's a `Dockerfile` in the upstream
template if you want one).

## Layout

```
app/
  root.tsx              document shell, header, boots the watcher
  routes.ts             route config
  app.css               the Modernist design system
  routes/
    watching.tsx        the list, the banner, the stats
    add.tsx             find a page → pick sizes → save
    settings.tsx        alerts, cadence, browser notifications
    console.tsx         the terminal
  lib/
    parse.ts            all page parsing — pure functions, no I/O
    check.server.ts     one check + the decision to alert
    watcher.server.ts   the background sweep loop
    items.server.ts     the watchlist store
    notify.server.ts    webhook delivery
    settings.server.ts  reads/writes .env
    console.server.ts   the console's command interpreter
    display.ts          shared formatting, safe on both sides
test/
  parse.test.ts         fixture-based tests for the parsers
data/                   your watchlist + per-item alert state (gitignored)
```

`parse.ts` is the part with real tests — it's pure, it's where a site change
bites first, and it's the one place a bug silently costs you a restock.

```bash
npm test          # parsers, against fixtures — never touches the live site
npm run typecheck
```

## If it stops working

Open the Console and run `check`. Look at what it reports:

- `via variation-api` — the good path.
- `via html` — the endpoint call failed; parsing is working off markup.
- an error line — the page couldn't be fetched at all. Check the address in a
  browser; a bot-check or CAPTCHA page will look like this.

`npm test` will tell you whether a change broke the parsing logic — but only
the real page can tell you whether the site changed shape underneath it.
