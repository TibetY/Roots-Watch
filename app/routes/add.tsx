import { useEffect, useState } from "react";
import { data, Link, redirect, useFetcher, useSearchParams } from "react-router";

import type { Route } from "./+types/add";
import { checkOnce } from "~/lib/check.server";
import { addItem, getItem, updateItem } from "~/lib/items.server";
import { readSettings } from "~/lib/settings.server";
import { requireUser } from "~/lib/supabase.server";
import { checkItemNow } from "~/lib/watcher.server";
import { DURATIONS } from "~/lib/display";
import type { PageSize } from "~/lib/parse";

export async function loader({ request }: Route.LoaderArgs) {
  const { db, userId, headers } = await requireUser(request);
  const editId = new URL(request.url).searchParams.get("edit");
  const [editing, settings] = await Promise.all([
    editId ? getItem(db, editId) : Promise.resolve(null),
    readSettings(db, userId),
  ]);
  return data(
    {
      editing,
      // Whether alerts have somewhere to go, and what kind of somewhere — but
      // never the topic itself. See the note in root.tsx.
      settings: { hasChannel: settings.hasChannel, destination: alertDestination(settings) },
      watcher: { intervalMinutes: settings.intervalMinutes },
    },
    { headers },
  );
}

export async function action({ request }: Route.ActionArgs) {
  const { db, userId } = await requireUser(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  // "Find it" — read the page once and report what's on it. Deliberately a
  // pure read: no state written, nothing sent, so previewing a URL can never
  // fire an alert or disturb a real watch.
  if (intent === "preview") {
    const url = String(form.get("url") ?? "").trim();
    if (!url) return { preview: null, error: "Paste a product page address first." };
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return { preview: null, error: "Only http(s) addresses can be watched." };
      }
    } catch {
      return { preview: null, error: `"${url}" isn't a valid web address.` };
    }

    const report = await checkOnce(url, []);
    return {
      preview: {
        url,
        product: report.productName,
        image: report.image,
        price: report.price,
        currency: report.currency,
        sizes: report.allSizes,
        confidence: report.confidence,
        source: report.source,
        error: report.error,
      },
      error: null,
    };
  }

  if (intent === "save") {
    const id = String(form.get("id") ?? "");
    const input = {
      url: String(form.get("url") ?? "").trim(),
      sizes: form.getAll("sizes").map(String),
      durationDays: Number(form.get("durationDays") ?? 0),
      enabled: form.get("enabled") !== "false",
    };

    try {
      if (id) {
        await updateItem(db, id, input);
      } else {
        const created = await addItem(db, userId, input);
        // Kick off the first check without making the user wait on a fetch.
        // On a serverless host the request may be torn down before this
        // settles, which is fine: the scheduled sweep picks up anything that
        // has never been checked first.
        if (created.enabled) {
          const settings = await readSettings(db, userId);
          void checkItemNow(db, userId, created, settings).catch(() => {});
        }
      }
    } catch (error) {
      return { preview: null, error: (error as Error).message };
    }
    return redirect("/");
  }

  return { preview: null, error: "Unknown action." };
}

type Preview = {
  url: string;
  product: string | null;
  image: string | null;
  price: unknown;
  currency: string | null;
  sizes: PageSize[];
  confidence: string;
  source: string;
  error: string | null;
};

export default function Add({ loaderData }: Route.ComponentProps) {
  const { editing, settings, watcher } = loaderData;
  const [searchParams] = useSearchParams();
  const editId = searchParams.get("edit") ?? "";

  const finder = useFetcher<{ preview: Preview | null; error: string | null }>();
  const saver = useFetcher<{ preview: null; error: string | null }>();

  const [url, setUrl] = useState(editing?.url ?? "");
  const [selected, setSelected] = useState<string[]>(editing?.sizes ?? []);
  const [durationDays, setDurationDays] = useState(editing?.durationDays ?? 0);

  // Editing an existing watch: read its page once on arrival so the size chips
  // show what the shop lists right now rather than what it listed when saved.
  const [autoRan, setAutoRan] = useState(false);
  useEffect(() => {
    if (editing && !autoRan) {
      setAutoRan(true);
      finder.submit({ intent: "preview", url: editing.url }, { method: "post" });
    }
  }, [editing, autoRan, finder]);

  const preview = finder.data?.preview ?? null;
  const finding = finder.state !== "idle";
  const error = finder.data?.error ?? saver.data?.error ?? null;

  const pageSizes = preview?.sizes ?? [];
  const toggle = (label: string) =>
    setSelected((prev) =>
      prev.includes(label) ? prev.filter((x) => x !== label) : [...prev, label],
    );

  const price = preview?.price
    ? `${preview.currency === "CAD" || preview.currency === "USD" ? "$" : ""}${preview.price}`
    : null;
  const availability = pageSizes.length
    ? pageSizes.some((size) => size.status === "in_stock")
      ? `${pageSizes.filter((s) => s.status === "in_stock").length} size(s) available right now`
      : "every size currently sold out"
    : "no sizes found on the page";

  return (
    <main className="wrap-narrow">
      <div className="head-rule">
        <h2>{editing ? "Edit watch" : "Watch an item"}</h2>
        <p className="sub">
          Pick the colour on the shop&rsquo;s own page first, then copy the address bar.
        </p>
      </div>

      {/* Find it */}
      <finder.Form method="post" style={{ padding: "28px 0", borderBottom: "2px solid var(--color-divider)" }}>
        <input type="hidden" name="intent" value="preview" />
        <label className="kicker" style={{ display: "block", marginBottom: 9 }} htmlFor="url">
          Product page
        </label>
        <div style={{ display: "flex", gap: 10 }}>
          <input
            id="url"
            name="url"
            type="url"
            className="input"
            style={{ flex: 1 }}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://www.roots.com/ca/en/…?dwvar_…_color=…"
          />
          <button className="btn btn-primary" style={{ padding: "0 20px" }} disabled={finding}>
            {finding ? "Reading…" : "Find it"}
          </button>
        </div>
        {error ? (
          <p className="err-text" style={{ marginTop: 10 }}>
            {error}
          </p>
        ) : null}
      </finder.Form>

      {/* What we found */}
      {preview ? (
        <div className="preview-card">
          <div className="preview-thumb">
            {preview.image ? <img src={preview.image} alt="" /> : null}
          </div>
          <div style={{ flex: 1 }}>
            <div className="kicker" style={{ color: "var(--color-accent-700)", marginBottom: 10 }}>
              {preview.error ? "Couldn't read the page" : "Read the page ✓"}
            </div>
            <h3 style={{ fontSize: 22, letterSpacing: "-.02em", margin: "0 0 7px" }}>
              {preview.product ?? "Unnamed product"}
            </h3>
            <p style={{ margin: 0, fontSize: 13, color: "var(--color-neutral-700)" }}>
              {preview.error
                ? preview.error
                : [price, availability].filter(Boolean).join(" · ") +
                  (preview.confidence === "low" ? " · read from markup, double-check it" : "")}
            </p>
          </div>
        </div>
      ) : null}

      {/* Save form — sizes, duration, submit */}
      <saver.Form method="post">
        <input type="hidden" name="intent" value="save" />
        <input type="hidden" name="id" value={editId} />
        <input type="hidden" name="url" value={url} />
        <input type="hidden" name="durationDays" value={durationDays} />
        {selected.map((size) => (
          <input key={size} type="hidden" name="sizes" value={size} />
        ))}

        {preview ? (
          <section className="sec">
            <h4>Which sizes do you want?</h4>
            <p className="hint">
              Taken straight off the page. Tap the ones you want to be told about.
            </p>
            {pageSizes.length ? (
              <>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
                  {pageSizes.map((size) => {
                    const label = size.label || size.value;
                    return (
                      <button
                        key={label}
                        type="button"
                        className="chip"
                        aria-pressed={selected.includes(label)}
                        onClick={() => toggle(label)}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
                <p style={{ margin: 0, fontSize: 12, color: "var(--color-neutral-700)" }}>
                  {selected.length
                    ? `${selected.length} selected — we'll tell you the moment any of them can go in a cart.`
                    : "Pick at least one size."}
                </p>
              </>
            ) : (
              <p style={{ margin: 0, fontSize: 12, color: "var(--color-neutral-700)" }}>
                We couldn&rsquo;t read a size list off that page. It may be a bot wall — try the
                address in a browser first.
              </p>
            )}
          </section>
        ) : null}

        <section className="sec two-col">
          <div>
            <h4>Check every</h4>
            <p className="hint">
              One loop checks every watch in turn — change the cadence under Settings.
            </p>
            <p style={{ margin: 0, fontFamily: "var(--font-heading)", fontWeight: 800 }}>
              {watcher.intervalMinutes} min
            </p>
          </div>
          <div>
            <h4>Keep checking for</h4>
            <p className="hint">Then it pauses itself and stays here to resume.</p>
            <div className="seg">
              {DURATIONS.map((option) => (
                <button
                  key={option.label}
                  type="button"
                  aria-pressed={option.days === durationDays}
                  onClick={() => setDurationDays(option.days)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="sec sec-strong row-between">
          <div>
            <h4>Alerts go to your phone</h4>
            <p style={{ margin: 0, fontSize: 13, color: "var(--color-neutral-700)" }}>
              {settings.hasChannel ? (
                <>
                  Sending via <span className="mono">{settings.destination}</span>. The channel
                  name itself only appears on the Settings screen — anyone holding it can read
                  your alerts.
                </>
              ) : (
                <span style={{ color: "var(--color-accent-700)" }}>
                  Nothing set up yet — you&rsquo;ll only see restocks in this app.
                </span>
              )}
            </p>
          </div>
          <Link className="btn btn-secondary" to="/settings">
            Change
          </Link>
        </section>

        <div className="row-between" style={{ padding: "28px 0" }}>
          {/* Say what's actually needed next — the save buttons are disabled
              until there are sizes, and a cadence summary next to two dead
              buttons reads as broken rather than as "you're not done yet". */}
          <p style={{ margin: 0, fontSize: 13, color: "var(--color-neutral-700)" }}>
            {!preview ? (
              <>
                Paste the address above and press <strong>Find it</strong> — we&rsquo;ll read the
                page and show you its sizes.
              </>
            ) : !selected.length ? (
              "Pick at least one size to watch."
            ) : (
              <>
                Checking every {watcher.intervalMinutes} min
                {durationDays
                  ? ` for ${DURATIONS.find((d) => d.days === durationDays)!.label.toLowerCase()}.`
                  : ", indefinitely."}
                {editing ? "" : " First check runs right away."}
              </>
            )}
          </p>
          <div style={{ display: "flex", gap: 10 }}>
            {!editing ? (
              <button
                className="btn btn-secondary btn-lg"
                name="enabled"
                value="false"
                disabled={!selected.length || saver.state !== "idle"}
              >
                Save paused
              </button>
            ) : null}
            <button
              className="btn btn-primary btn-lg"
              name="enabled"
              value="true"
              disabled={!selected.length || saver.state !== "idle"}
            >
              {saver.state !== "idle" ? "Saving…" : editing ? "Save changes" : "Start watching"}
            </button>
          </div>
        </div>
      </saver.Form>
    </main>
  );
}
