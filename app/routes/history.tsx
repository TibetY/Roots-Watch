import { useMemo } from "react";
import { data, Form, Link } from "react-router";

import type { Route } from "./+types/history";
import { readHistory } from "~/lib/history.server";
import { loadWatchlist } from "~/lib/items.server";
import { readSettings } from "~/lib/settings.server";
import { requireUser } from "~/lib/supabase.server";
import { loadStatuses } from "~/lib/watcher.server";
import { zonedCalendar, type Calendar } from "~/lib/calendar";
import { hostOf, stamp, dayStamp } from "~/lib/display";
import {
  describeHours,
  dropPattern,
  summarize,
  verdict,
  type DayCell,
  type WindowStats,
} from "~/lib/stats";

const WINDOWS = [7, 30, 90];

export async function loader({ request }: Route.LoaderArgs) {
  const { db, userId, headers } = await requireUser(request);
  const asked = Number(new URL(request.url).searchParams.get("days"));
  const days = WINDOWS.includes(asked) ? asked : 30;

  // One clock for the whole page, so two items can't be summarized against
  // timestamps a few milliseconds apart and disagree about where "today" ends.
  const now = Date.now();
  const settings = await readSettings(db, userId);
  // The server runs in UTC. Every day boundary on this screen is drawn in the
  // shopper's zone instead, or an evening restock lands on tomorrow.
  const calendar = zonedCalendar(settings.timezone);

  const [watchlist, statuses] = await Promise.all([
    loadWatchlist(db, userId),
    loadStatuses(db, userId),
  ]);

  const items = await Promise.all(
    watchlist.map(async (item) => {
      const status = statuses.get(item.id);
      const history = await readHistory(db, item.id, { days, timezone: settings.timezone });
      return {
        id: item.id,
        label: item.label,
        url: item.url,
        sizes: item.sizes,
        enabled: item.enabled,
        image: status?.image ?? null,
        inStockNow: (status?.sizes ?? []).some((size) => size.status === "in_stock"),
        stats: summarize(history, item.sizes, { days, now, calendar }),
      };
    }),
  );

  return data(
    { days, items, intervalMinutes: settings.intervalMinutes, timezone: settings.timezone },
    { headers },
  );
}

function Strip({ stats, cal }: { stats: WindowStats; cal: Calendar }) {
  return (
    <div className="strip-wrap">
      <div className="strip">
        {stats.cells.map((cell) => (
          <div
            key={cell.key}
            className={`strip-day${cell.recorded ? "" : " unrecorded"}`}
            title={cellTitle(cell, cal)}
          >
            <div className="strip-fill" style={{ height: `${Math.round(cell.coverage * 100)}%` }} />
            {cell.drops ? <span className="strip-drop" /> : null}
          </div>
        ))}
      </div>
      <div className="strip-axis">
        <span>{dayStamp(stats.from, cal)}</span>
        <span>today</span>
      </div>
      <div className="strip-key">
        <span>
          <i className="key-fill" /> hours we could read the page
        </span>
        <span>
          <i className="key-drop" /> a restock landed
        </span>
        <span>
          <i className="key-dark" /> dark — no successful read
        </span>
      </div>
    </div>
  );
}

function cellTitle(cell: DayCell, cal: Calendar): string {
  const date = dayStamp(cell.at, cal);
  if (!cell.recorded) return `${date} — not recorded`;
  const pct = Math.round(cell.coverage * 100);
  const drops = cell.drops ? ` · ${cell.drops} restock${cell.drops === 1 ? "" : "s"}` : "";
  return `${date} — ${cell.checks} check${cell.checks === 1 ? "" : "s"}, readable ${pct}% of the day${drops}`;
}

function Figures({ stats }: { stats: WindowStats }) {
  return (
    <div className="stats four tight">
      <div>
        <span className="kicker">Restocks caught</span>
        <div className="val">{stats.drops.length}</div>
      </div>
      <div>
        <span className="kicker">Time in stock</span>
        <div className="val">{stats.hoursInStock ? describeHours(stats.hoursInStock) : "none"}</div>
      </div>
      <div>
        <span className="kicker">Page readable</span>
        <div className="val">
          {stats.observedHours ? `${Math.round(stats.coverage * 100)}%` : "—"}
        </div>
      </div>
      <div>
        <span className="kicker">Checks run</span>
        <div className="val">{stats.checks.toLocaleString()}</div>
      </div>
    </div>
  );
}

type ItemRow = Route.ComponentProps["loaderData"]["items"][number];

function ItemHistory({
  item,
  intervalMinutes,
  cal,
}: {
  item: ItemRow;
  intervalMinutes: number;
  cal: Calendar;
}) {
  const { stats } = item;
  const call = verdict(stats);
  const pattern = dropPattern(stats);

  return (
    <section className="past">
      <div className="past-head">
        <div className="past-thumb">{item.image ? <img src={item.image} alt="" /> : null}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3>{item.label}</h3>
          <p className="row-sub">
            {[hostOf(item.url), `watching ${item.sizes.join(", ")}`].filter(Boolean).join(" · ")}
          </p>
        </div>
        <div className="past-since">
          {stats.since ? `Recording since ${dayStamp(stats.since, cal)}` : "Not recording yet"}
        </div>
      </div>

      <p className={`verdict ${call.tone}`}>{call.line}</p>

      <Figures stats={stats} />
      <Strip stats={stats} cal={cal} />

      <div className="two-col past-cols">
        <div>
          <h4>Restocks</h4>
          {stats.drops.length ? (
            <ul className="log">
              {stats.drops.map((drop) => (
                <li key={drop.at}>
                  <div className="log-when">{stamp(drop.at, cal)}</div>
                  <div>
                    <strong>Size {drop.sizes.join(" & ")}</strong>
                    {drop.price ? ` · $${drop.price}` : ""}
                    <div className="log-note">
                      {drop.endedAt
                        ? `${drop.uncertain ? "At least " : "Stayed up "}${describeHours(drop.hours)}${drop.uncertain ? " — we went blind partway through" : ""}`
                        : item.inStockNow
                          ? "Still in stock"
                          : "We never saw it end"}
                      {drop.alerted ? " · alert sent" : " · no alert went out"}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="sub">
              Nothing came back in this window
              {stats.coverage < 0.98 ? " that we were awake for" : ""}.
            </p>
          )}

          {stats.neverSeen.length ? (
            <p className="sub past-aside">
              Never once in stock here: <strong>{stats.neverSeen.join(", ")}</strong>. Over{" "}
              {stats.days} days that starts to look less like sold out and more like discontinued.
            </p>
          ) : null}
        </div>

        <div>
          <h4>Hours we can&rsquo;t account for</h4>
          {stats.gaps.length ? (
            <>
              <ul className="log">
                {stats.gaps.slice(0, 6).map((gap) => (
                  <li key={gap.from}>
                    <div className="log-when">{stamp(gap.from, cal)}</div>
                    <div>
                      <strong>{describeHours(gap.hours)} dark</strong>
                      <div className="log-note">until {stamp(gap.to, cal)}</div>
                    </div>
                  </li>
                ))}
              </ul>
              {stats.gaps.length > 6 ? (
                <p className="sub past-aside">
                  and {stats.gaps.length - 6} shorter{" "}
                  {stats.gaps.length - 6 === 1 ? "stretch" : "stretches"}.
                </p>
              ) : null}
            </>
          ) : (
            <p className="sub">
              {stats.observedHours
                ? "None. Every hour since we started recording has at least one successful read behind it."
                : "Nothing recorded yet."}
            </p>
          )}

          <div className="past-facts">
            {stats.priceLow ? (
              <p>
                <span className="kicker">Price</span>
                {stats.priceLow === stats.priceHigh
                  ? `$${stats.priceLow} throughout`
                  : `moved between $${stats.priceLow} and $${stats.priceHigh}`}
              </p>
            ) : null}
            <p>
              <span className="kicker">How fast you&rsquo;d hear</span>
              within {intervalMinutes} min of a restock, worst case — that&rsquo;s the check
              interval.
            </p>
            {stats.checks ? (
              <p>
                <span className="kicker">Reads that worked</span>
                {stats.reads} of {stats.checks} checks ({Math.round(stats.reliability * 100)}%)
              </p>
            ) : null}
            {pattern ? (
              <p>
                <span className="kicker">Pattern</span>
                {pattern}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

export default function History({ loaderData }: Route.ComponentProps) {
  const { days, items, intervalMinutes, timezone } = loaderData;
  // Built from the stored zone rather than the browser's, so the server render
  // and the hydrated one agree — and so the dates match the ones the loader
  // already bucketed by.
  const cal = useMemo(() => zonedCalendar(timezone), [timezone]);

  return (
    <main className="wrap">
      <div className="page-head" style={{ borderBottom: "2px solid var(--color-divider)" }}>
        <div>
          <div
            className="kicker"
            style={{ color: "var(--color-accent-700)", marginBottom: 12, letterSpacing: ".12em" }}
          >
            Looking back
          </div>
          <h2>The past {days} days</h2>
          <p className="sub" style={{ maxWidth: "64ch" }}>
            What came back in stock, and — just as important — how much of the window we could
            actually see. A quiet month and an unwatched month look identical unless someone says
            which one it was.
          </p>
        </div>
        <Form method="get" className="seg">
          {WINDOWS.map((window) => (
            <button key={window} name="days" value={window} aria-pressed={window === days}>
              {window} days
            </button>
          ))}
        </Form>
      </div>

      {items.length ? (
        items.map((item) => (
          <ItemHistory key={item.id} item={item} intervalMinutes={intervalMinutes} cal={cal} />
        ))
      ) : (
        <div className="empty">
          <h3>No watches, no history</h3>
          <p className="sub" style={{ marginBottom: 22 }}>
            Add something to watch and this fills in from the first check onward.
          </p>
          <Link
            className="btn btn-primary btn-lg"
            to="/add"
            style={{ maxWidth: 240, margin: "0 auto" }}
          >
            ＋ Watch an item
          </Link>
        </div>
      )}

      <p className="past-footnote">
        History starts the first time a check runs — it can&rsquo;t reconstruct what happened before
        that, and it says so rather than showing you a confident zero. Kept for 90 days, then the
        oldest days roll off.
      </p>
    </main>
  );
}
