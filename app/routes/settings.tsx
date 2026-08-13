import { useEffect, useState } from "react";
import { data, useFetcher } from "react-router";

import type { Route } from "./+types/settings";
import { loadWatchlist } from "~/lib/items.server";
import { notifyAll } from "~/lib/notify.server";
import { readSettings, saveSettings, validateSettings } from "~/lib/settings.server";
import { requireUser } from "~/lib/supabase.server";
import { checkItemNow, watcherStats } from "~/lib/watcher.server";
import { INTERVALS } from "~/lib/display";

export async function loader({ request }: Route.LoaderArgs) {
  const { db, userId, headers } = await requireUser(request);
  const [items, settings] = await Promise.all([
    loadWatchlist(db, userId),
    readSettings(db, userId),
  ]);
  // This is the one screen that legitimately shows the webhook and topic:
  // it is the form for editing them.
  return data(
    {
      settings,
      watcher: await watcherStats(db, userId, settings),
      counts: { total: items.length, active: items.filter((item) => item.enabled).length },
    },
    { headers },
  );
}

export async function action({ request }: Route.ActionArgs) {
  const { db, userId } = await requireUser(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  try {
    if (intent === "save") {
      const settings = await saveSettings(db, userId, {
        webhookUrl: String(form.get("webhookUrl") ?? ""),
        webhookTopic: String(form.get("webhookTopic") ?? ""),
        timezone: String(form.get("timezone") ?? ""),
      });
      return { ok: true, message: "Saved.", settings };
    }

    if (intent === "test") {
      // Test whatever is in the form right now, so you can prove a webhook
      // works before committing it.
      const candidate = validateSettings({
        webhookUrl: String(form.get("webhookUrl") ?? ""),
        webhookTopic: String(form.get("webhookTopic") ?? ""),
      });
      if (!candidate.webhookUrl) {
        return { ok: false, message: "Enter a webhook address first." };
      }
      const [result] = await notifyAll(
        candidate,
        "Test notification from your restock watcher. If this arrived, alerts are wired up.",
        { title: "Restock — test" },
      );
      return result?.ok
        ? { ok: true, message: "Sent — check your phone." }
        : { ok: false, message: result?.detail ?? "Failed to send." };
    }

    if (intent === "control") {
      const patch: { autoRun?: boolean; intervalMinutes?: number } = {};
      if (form.has("autoRun")) patch.autoRun = form.get("autoRun") === "true";
      if (form.has("intervalMinutes")) patch.intervalMinutes = Number(form.get("intervalMinutes"));
      // Cadence is a stored setting now, read by the scheduled sweep — not a
      // timer this process owns. Nothing here restarts anything.
      await saveSettings(db, userId, patch);
      return { ok: true, message: null };
    }

    if (intent === "checkAll") {
      const settings = await readSettings(db, userId);
      const items = await loadWatchlist(db, userId);
      for (const item of items.filter((entry) => entry.enabled)) {
        await checkItemNow(db, userId, item, settings);
      }
      return { ok: true, message: "Checked everything." };
    }
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }

  return { ok: false, message: "Unknown action." };
}

/** Browser notifications live entirely client-side — permission is per browser. */
function BrowserAlerts() {
  const [on, setOn] = useState(false);
  const [supported, setSupported] = useState(true);
  const [permission, setPermission] = useState<NotificationPermission>("default");

  useEffect(() => {
    const ok = typeof window !== "undefined" && "Notification" in window;
    setSupported(ok);
    if (ok) {
      setPermission(Notification.permission);
      setOn(localStorage.getItem("restockBrowserAlerts") === "on" && Notification.permission === "granted");
    }
  }, []);

  async function toggle() {
    if (!supported) return;
    if (!on) {
      const granted =
        Notification.permission === "granted"
          ? "granted"
          : await Notification.requestPermission();
      setPermission(granted);
      if (granted !== "granted") return;
      localStorage.setItem("restockBrowserAlerts", "on");
      setOn(true);
    } else {
      localStorage.setItem("restockBrowserAlerts", "off");
      setOn(false);
    }
  }

  const label = !supported
    ? "Not supported in this browser"
    : on
      ? "On for this browser"
      : permission === "denied"
        ? "Blocked in browser settings"
        : "Off";

  return (
    <div className="row-between" style={{ paddingBottom: 32, borderBottom: "1px solid var(--color-divider)" }}>
      <div className="check-item">
        <span className={on ? "check-box" : "check-box off"} />
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 5 }}>{label}</div>
          <p style={{ margin: 0, fontSize: 13, color: "var(--color-neutral-700)" }}>
            Native notifications from this tab while it&rsquo;s open — on top of the push above,
            not instead of it.
          </p>
        </div>
      </div>
      <button className="btn btn-secondary" onClick={toggle} disabled={!supported}>
        {on ? "Turn off" : "Turn on"}
      </button>
    </div>
  );
}

export default function Settings({ loaderData }: Route.ComponentProps) {
  const { settings, watcher, counts } = loaderData;
  const saver = useFetcher<{ ok: boolean; message: string | null }>();
  const tester = useFetcher<{ ok: boolean; message: string | null }>();
  const control = useFetcher();
  const checker = useFetcher<{ ok: boolean; message: string | null }>();

  const [webhookUrl, setWebhookUrl] = useState(settings.webhookUrl);
  const [webhookTopic, setWebhookTopic] = useState(settings.webhookTopic);

  const autoRun = control.formData
    ? control.formData.get("autoRun") === "true"
    : watcher.autoRun;
  const intervalMinutes = control.formData?.get("intervalMinutes")
    ? Number(control.formData.get("intervalMinutes"))
    : watcher.intervalMinutes;

  return (
    <main className="wrap-mid">
      <div className="head-rule">
        <h2>How you get alerted</h2>
        <p className="sub">One free app on your phone. No email, no account with anyone else.</p>
      </div>

      <div className="steps">
        <div>
          <div className="step-num">01</div>
          <h4>Install ntfy</h4>
          <p>It&rsquo;s free and takes a minute.</p>
          <a className="btn btn-secondary" href="https://ntfy.sh" target="_blank" rel="noopener noreferrer">
            ntfy.sh ↗
          </a>
        </div>

        <div>
          <div className="step-num">02</div>
          <h4>Point us at it</h4>
          <p>The server origin, then your topic.</p>
          <input
            className="input"
            style={{ minHeight: 40, marginBottom: 8, fontFamily: "var(--mono)", fontSize: 12 }}
            value={webhookUrl}
            onChange={(event) => setWebhookUrl(event.target.value)}
            placeholder="https://ntfy.sh"
            aria-label="Webhook address"
          />
          <input
            className="input"
            style={{ minHeight: 40, fontFamily: "var(--mono)", fontSize: 12 }}
            value={webhookTopic}
            onChange={(event) => setWebhookTopic(event.target.value)}
            placeholder="your-private-topic"
            aria-label="ntfy topic"
          />
        </div>

        <div>
          <div className="step-num">03</div>
          <h4>Check it works</h4>
          <p>A test push, right now.</p>
          <tester.Form method="post">
            <input type="hidden" name="intent" value="test" />
            <input type="hidden" name="webhookUrl" value={webhookUrl} />
            <input type="hidden" name="webhookTopic" value={webhookTopic} />
            <button className="btn btn-secondary" disabled={tester.state !== "idle"}>
              {tester.state !== "idle" ? "Sending…" : "Send a test"}
            </button>
          </tester.Form>
          {tester.data?.message ? (
            <p
              style={{
                margin: "12px 0 0",
                fontSize: 12,
                color: tester.data.ok ? "var(--color-accent-700)" : "var(--color-accent)",
              }}
            >
              {tester.data.ok ? "✓ " : "✗ "}
              {tester.data.message}
            </p>
          ) : null}
        </div>

        <div>
          <span className="kicker" style={{ display: "block", marginBottom: 12 }}>
            Your private channel
          </span>
          <div className="token-box">{webhookTopic || webhookUrl || "not set"}</div>
          <p style={{ margin: "0 0 14px", fontSize: 12, color: "var(--color-neutral-700)" }}>
            Anyone who knows this name can read your alerts. Make it long — don&rsquo;t share it.
          </p>
          <saver.Form method="post" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input type="hidden" name="intent" value="save" />
            <input type="hidden" name="webhookUrl" value={webhookUrl} />
            <input type="hidden" name="webhookTopic" value={webhookTopic} />
            <button className="btn btn-primary" disabled={saver.state !== "idle"}>
              {saver.state !== "idle" ? "Saving…" : "Save"}
            </button>
          </saver.Form>
          {saver.data?.message ? (
            <p
              style={{
                margin: "10px 0 0",
                fontSize: 12,
                color: saver.data.ok ? "var(--color-accent-700)" : "var(--color-accent)",
              }}
            >
              {saver.data.message}
            </p>
          ) : null}
        </div>
      </div>

      <div style={{ padding: "44px 0 24px" }}>
        <h3 style={{ fontSize: 26, letterSpacing: "-.02em", margin: "0 0 8px" }}>Browser alerts</h3>
      </div>
      <BrowserAlerts />

      <div style={{ padding: "44px 0 24px" }}>
        <h3 style={{ fontSize: 26, letterSpacing: "-.02em", margin: "0 0 8px" }}>
          How often we check
        </h3>
        <p className="sub">
          One loop checks every watch in turn, staggered so we don&rsquo;t hammer the shop.
        </p>
      </div>

      <div className="two-col" style={{ paddingBottom: 36, borderBottom: "1px solid var(--color-divider)" }}>
        <div>
          <h4 style={{ fontSize: 17, margin: "0 0 14px" }}>Check every</h4>
          <div className="seg">
            {INTERVALS.map((option) => (
              <button
                key={option.label}
                type="button"
                aria-pressed={option.minutes === intervalMinutes}
                onClick={() =>
                  control.submit(
                    { intent: "control", intervalMinutes: String(option.minutes) },
                    { method: "post" },
                  )
                }
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <h4 style={{ fontSize: 17, margin: "0 0 14px" }}>Checking is</h4>
          <div className="seg">
            {[
              { label: "Running", value: true },
              { label: "Paused", value: false },
            ].map((option) => (
              <button
                key={option.label}
                type="button"
                aria-pressed={option.value === autoRun}
                onClick={() =>
                  control.submit(
                    { intent: "control", autoRun: String(option.value) },
                    { method: "post" },
                  )
                }
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="two-col" style={{ padding: "32px 0", borderBottom: "2px solid var(--color-divider)" }}>
        <div className="check-item">
          <span className="check-box" />
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 5 }}>
              Don&rsquo;t tell me twice
            </div>
            <p style={{ margin: 0, fontSize: 13, color: "var(--color-neutral-700)" }}>
              While a size stays in stock, we wait 6 hours before mentioning it again.
            </p>
          </div>
        </div>
        <div className="check-item">
          <span className="check-box" />
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 5 }}>
              Tell me when we go blind
            </div>
            <p style={{ margin: 0, fontSize: 13, color: "var(--color-neutral-700)" }}>
              If a page can&rsquo;t be read for 2 hours, that&rsquo;s worth knowing about.
            </p>
          </div>
        </div>
      </div>

      <div className="row-between" style={{ padding: "32px 0" }}>
        <div>
          <span className="kicker" style={{ display: "block", marginBottom: 7 }}>
            Watchlist
          </span>
          <div style={{ fontSize: 15 }}>
            {counts.total
              ? `${counts.active} of ${counts.total} item${counts.total === 1 ? "" : "s"} being checked`
              : "Nothing on the list yet"}
          </div>
        </div>
        <checker.Form method="post">
          <input type="hidden" name="intent" value="checkAll" />
          <button className="btn btn-secondary" disabled={checker.state !== "idle"}>
            {checker.state !== "idle" ? "Checking…" : "Check everything now"}
          </button>
        </checker.Form>
      </div>
    </main>
  );
}
