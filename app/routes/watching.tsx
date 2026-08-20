import { useEffect, useState } from "react";
import { data, Form, Link } from "react-router";

import type { Route } from "./+types/watching";
import { loadWatchlist, removeItem, updateItem } from "~/lib/items.server";
import { isReason, REASONS } from "~/lib/outcomes";
import { readTally, recordOutcome } from "~/lib/outcomes.server";
import { readSettings } from "~/lib/settings.server";
import { publicEnv, requireUser } from "~/lib/supabase.server";
import { useLiveUpdates } from "~/lib/live";
import {
  checkItemNow,
  isChecking,
  loadStatuses,
  summaryFrom,
  watcherStats,
} from "~/lib/watcher.server";
import {
  ago,
  alertDestination,
  BLIND_CREED,
  blindReason,
  hostOf,
  inStockSizes,
  money,
  stateOf,
  until,
  type ItemView,
} from "~/lib/display";

export async function loader({ request }: Route.LoaderArgs) {
  const { db, userId, headers } = await requireUser(request);
  const [items, statuses, settings, tally] = await Promise.all([
    loadWatchlist(db, userId),
    loadStatuses(db, userId),
    readSettings(db, userId),
    readTally(db, userId),
  ]);

  return data(
    {
      items: items.map((item) => {
        const row = statuses.get(item.id);
        return {
          ...item,
          status: summaryFrom(row),
          checking: isChecking(row),
        };
      }) satisfies ItemView[],
      watcher: await watcherStats(db, userId, settings),
      // Only the flag, never the topic — see the note in root.tsx.
      alerts: { hasChannel: settings.hasChannel, destination: alertDestination(settings) },
      tally,
      env: publicEnv(),
    },
    { headers },
  );
}

export async function action({ request }: Route.ActionArgs) {
  const { db, userId, headers } = await requireUser(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const id = String(form.get("id") ?? "");

  try {
    if (intent === "pause" || intent === "resume") {
      await updateItem(db, id, { enabled: intent === "resume" });
      return data({ ok: true }, { headers });
    }
    // Stopping a watch on something you found is the one moment worth asking
    // why: you know the answer, and you are about to stop thinking about this
    // item for good. Ask later and it is guesswork; ask earlier and it is noise.
    if (intent === "stop") {
      const reason = form.get("reason");
      if (!isReason(reason)) {
        return data({ ok: false, error: "Pick one of the reasons." }, { headers });
      }
      const items = await loadWatchlist(db, userId);
      const item = items.find((entry) => entry.id === id);
      if (item) {
        // Recorded before the item is touched. If the pause failed afterwards
        // you would still have answered honestly, and a watch that is still
        // running is a smaller problem than a tally with a hole in it.
        await recordOutcome(db, userId, item, reason);
        await updateItem(db, id, { enabled: false });
      }
      return data({ ok: true }, { headers });
    }
    if (intent === "remove") {
      // Status, alert state, checks and events go with it, by cascade.
      // Outcomes do not: see supabase/migrations/0002_outcomes.sql.
      await removeItem(db, id);
      return data({ ok: true }, { headers });
    }
    if (intent === "check") {
      const items = await loadWatchlist(db, userId);
      const item = items.find((entry) => entry.id === id);
      if (item) await checkItemNow(db, userId, item, await readSettings(db, userId));
      return data({ ok: true }, { headers });
    }
  } catch (error) {
    return data({ ok: false, error: (error as Error).message }, { headers });
  }
  return data({ ok: false, error: "Unknown action." }, { headers });
}

function SizeTags({ item }: { item: ItemView }) {
  const sizes = item.status?.sizes?.length
    ? item.status.sizes
    : item.sizes.map((wanted) => ({ wanted, matchedLabel: null, status: "pending" as const }));

  return (
    <div className="row-sizes">
      <span className="kicker" style={{ marginRight: 4 }}>
        Watching sizes
      </span>
      {sizes.map((size) => {
        const label = size.matchedLabel ?? size.wanted;
        if (size.status === "in_stock") {
          return (
            <span key={size.wanted} className="tag tag-hit">
              {label} — available
            </span>
          );
        }
        if (size.status === "unknown") {
          return (
            <span key={size.wanted} className="tag tag-outline">
              {label}
            </span>
          );
        }
        return (
          <span key={size.wanted} className="tag tag-neutral">
            {label}
          </span>
        );
      })}
    </div>
  );
}

function ItemRow({ item, intervalMinutes }: { item: ItemView; intervalMinutes: number }) {
  const [asking, setAsking] = useState(false);
  const state = stateOf(item);
  const status = item.status;
  const sub = [money(status), hostOf(item.url)].filter(Boolean).join(" · ");

  let tag: React.ReactNode = null;
  let when: string | null = null;
  let note: string | null = null;
  let detail: string | null = null; // the raw error, shown small under the note

  if (state === "in_stock") {
    tag = <span className="tag tag-hit">In stock now</span>;
    when = `Found ${ago(status!.checkedAt) ?? "just now"}${status!.alerted.length ? " · alert sent" : ""}`;
  } else if (state === "blind") {
    tag = <span className="tag tag-outline">Can&rsquo;t read the page</span>;
    // How stale the row is, not when we last failed — that's the number that
    // tells you whether to trust the sizes still showing above.
    when = status?.lastGoodAt
      ? `Last good check ${ago(status.lastGoodAt)}`
      : "Never managed to read it";
    note = `${blindReason(status?.error)} ${BLIND_CREED}`;
    detail = status?.error ?? null;
  } else if (state === "paused") {
    tag = <span className="tag tag-neutral">Paused</span>;
    when =
      item.expiresAt && Date.parse(item.expiresAt) <= Date.now()
        ? "Ran out its time"
        : "Not being checked";
  } else if (state === "pending") {
    tag = <span className="tag tag-neutral">Not checked yet</span>;
  } else {
    tag = <span className="tag tag-neutral">Checking every {intervalMinutes} min</span>;
    when =
      [
        status?.checkedAt ? `Last check ${ago(status.checkedAt)}` : null,
        item.expiresAt ? `stops in ${until(item.expiresAt)}` : null,
      ]
        .filter(Boolean)
        .join(" · ") || null;
  }

  return (
    <article
      className={`row${state === "in_stock" ? " is-hit" : ""}${state === "paused" ? " is-paused" : ""}`}
    >
      <div className="row-thumb">
        {status?.image ? <img src={status.image} alt="" loading="lazy" /> : null}
      </div>

      <div>
        <div className="row-meta">
          {tag}
          {when ? <span className="when">{when}</span> : null}
        </div>
        <h3>{item.label}</h3>
        {sub ? <p className="row-sub">{sub}</p> : null}
        {note ? (
          <>
            <p className="row-note">{note}</p>
            {detail ? <p className="row-detail">{detail}</p> : null}
          </>
        ) : (
          <SizeTags item={item} />
        )}
      </div>

      <div className="row-actions">
        {state === "in_stock" ? (
          <>
            <a
              className="btn btn-primary"
              href={status!.buyLink ?? item.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              Buy it ↗
            </a>
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => setAsking(true)}
            >
              Stop watching
            </button>
          </>
        ) : state === "paused" ? (
          <>
            <Form method="post">
              <input type="hidden" name="id" value={item.id} />
              <button className="btn btn-primary" name="intent" value="resume">
                Resume
              </button>
            </Form>
            <Link className="btn btn-secondary" to={`/add?edit=${item.id}`}>
              Edit watch
            </Link>
          </>
        ) : (
          <>
            <Form method="post">
              <input type="hidden" name="id" value={item.id} />
              <button className="btn btn-secondary" name="intent" value="check" disabled={item.checking}>
                {item.checking ? (
                  <>
                    <span className="spin">⟳</span> Checking…
                  </>
                ) : (
                  "Check now"
                )}
              </button>
            </Form>
            <Link className="btn btn-secondary" to={`/add?edit=${item.id}`}>
              Edit watch
            </Link>
          </>
        )}

        <div className="more">
          {state !== "paused" && state !== "in_stock" ? (
            <Form method="post">
              <input type="hidden" name="id" value={item.id} />
              <button className="btn btn-ghost" name="intent" value="pause">
                Pause
              </button>
            </Form>
          ) : null}
          <Form
            method="post"
            onSubmit={(event) => {
              if (!confirm(`Stop watching "${item.label}" and remove it?`)) event.preventDefault();
            }}
          >
            <input type="hidden" name="id" value={item.id} />
            <button className="btn btn-ghost" name="intent" value="remove">
              Remove
            </button>
          </Form>
        </div>
      </div>

      {asking ? (
        <div className="row-why">
          <div>
            <span className="kicker">Before you go</span>
            <p>Did we actually help?</p>
          </div>
          <div className="row-why-options">
            {REASONS.map((reason) => (
              <Form method="post" key={reason.value}>
                <input type="hidden" name="id" value={item.id} />
                <input type="hidden" name="reason" value={reason.value} />
                <button
                  className="btn btn-secondary"
                  name="intent"
                  value="stop"
                  title={reason.hint}
                >
                  {reason.label}
                </button>
              </Form>
            ))}
            <button className="btn btn-ghost" type="button" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function Banner({ item, onDismiss }: { item: ItemView; onDismiss: () => void }) {
  const sizes = inStockSizes(item).join(" & ");
  const price = money(item.status);
  const host = hostOf(item.url);

  return (
    <section className="banner">
      <div className="banner-inner">
        <div className="banner-thumb">
          {item.status?.image ? <img src={item.status.image} alt="" /> : null}
        </div>
        <div style={{ flex: 1 }}>
          <div className="banner-kicker">
            Size {sizes} · found {ago(item.status?.checkedAt) ?? "just now"}
            {host ? ` · ${host}` : ""}
          </div>
          <h1>Back in stock</h1>
          <p style={{ margin: 0, fontSize: 17, opacity: 0.9 }}>
            {item.label}
            {price ? ` — ${price}` : ""}
          </p>
        </div>
        <div className="banner-actions">
          <a
            className="btn btn-invert"
            href={item.status?.buyLink ?? item.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Buy it now ↗
          </a>
          <button className="btn btn-outline" onClick={onDismiss}>
            Keep watching
          </button>
        </div>
      </div>
    </section>
  );
}

export default function Watching({ loaderData }: Route.ComponentProps) {
  const { items, watcher, alerts, tally, env } = loaderData;
  useLiveUpdates(env);

  const [dismissed, setDismissed] = useState<string | null>(null);
  const hit = items.find((item) => stateOf(item) === "in_stock" && item.id !== dismissed);

  // A watch that drops back out of stock should be able to raise its banner
  // again the next time it returns.
  useEffect(() => {
    if (dismissed && !items.some((item) => item.id === dismissed && stateOf(item) === "in_stock")) {
      setDismissed(null);
    }
  }, [items, dismissed]);

  return (
    <main>
      {hit ? <Banner item={hit} onDismiss={() => setDismissed(hit.id)} /> : null}

      <div className="wrap">
        <div className="page-head">
          <div>
            <h2>
              {items.length
                ? `Watching ${items.length} item${items.length === 1 ? "" : "s"}`
                : "Watching nothing yet"}
            </h2>
            <p className="sub">
              Checks run in the background here. Nothing needs to stay open in your browser.
            </p>
          </div>
          <Link className="btn btn-primary btn-lg" to="/add">
            ＋ Watch an item
          </Link>
        </div>

        {items.length ? (
          <div className="rows">
            {items.map((item) => (
              <ItemRow key={item.id} item={item} intervalMinutes={watcher.intervalMinutes} />
            ))}
          </div>
        ) : (
          <div className="empty">
            <h3>Nothing on the list</h3>
            <p className="sub" style={{ marginBottom: 22 }}>
              Add a product page and we&rsquo;ll watch it for you.
            </p>
            <Link className="btn btn-primary btn-lg btn-block" to="/add" style={{ maxWidth: 240, margin: "0 auto" }}>
              ＋ Watch an item
            </Link>
          </div>
        )}

        <div className="stats four">
          <div>
            <span className="kicker">Found because of us</span>
            <div className="val">{tally.foundHere.toLocaleString()}</div>
          </div>
          <div>
            {/* "This session" meant something when a process stayed up. There
                are no sessions now, so the honest window is a day. */}
            <span className="kicker">Checks today</span>
            <div className="val">{watcher.checksToday.toLocaleString()}</div>
          </div>
          <div>
            <span className="kicker">Alerts today</span>
            <div className="val">{watcher.alertsToday.toLocaleString()}</div>
          </div>
          <div>
            <span className="kicker">Alerts go to</span>
            <div className="val">{alerts.destination}</div>
          </div>
        </div>
      </div>
    </main>
  );
}
