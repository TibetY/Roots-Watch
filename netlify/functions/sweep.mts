// The watcher, as a cron job.
//
// This is the piece that makes the whole thing worth hosting: it runs whether
// or not a browser is open, whether or not your laptop is awake. Everything
// else in the app is a way of looking at what this produced.
//
// It uses the service-role key, which bypasses row level security — it has to,
// because it runs on behalf of no one and has to see every user's watchlist.
// That key exists only in Netlify's environment. Nothing in app/ reads it.

import { createClient } from "@supabase/supabase-js";
import type { Config } from "@netlify/functions";

import { pruneHistory } from "../../app/lib/history.server";
import { sweepUser } from "../../app/lib/watcher.server";

/**
 * How long to spend checking before handing the rest to the next run.
 *
 * Deliberately well under any plausible platform timeout rather than tuned to
 * a specific one — Netlify's execution limit differs by plan and has changed
 * more than once, and a budget that quietly exceeds it means the function is
 * killed rather than finishing tidily. Eight seconds checks a handful of items
 * per tick, and with a five-minute heartbeat that is far more throughput than
 * a ten-minute cadence needs.
 *
 * Raise it with SWEEP_BUDGET_MS if a long watchlist starts trailing; `remaining`
 * in the response says whether it is.
 */
const BUDGET_MS = Number(process.env.SWEEP_BUDGET_MS ?? 8_000);

export default async function sweep(): Promise<Response> {
  // Logged unconditionally, first thing. The question this function most often
  // has to answer is not "did it work" but "did it run at all", and a silent
  // success looks identical to never having been invoked.
  console.log(`[sweep] fired at ${new Date().toISOString()}`);

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    const missing = [!url && "SUPABASE_URL", !key && "SUPABASE_SERVICE_ROLE_KEY"]
      .filter(Boolean)
      .join(" and ");
    console.error(`[sweep] not configured: ${missing} missing from the environment`);
    return Response.json({ ok: false, error: `${missing} must be set` }, { status: 500 });
  }

  // Supabase's dashboard lists the JWT *signing secret* under a heading close
  // enough to the API keys that the two get swapped. Pasting the signing
  // secret here fails every query with an unhelpful 401 from PostgREST — the
  // sweep looks like it ran and found nothing. A shape check turns that into a
  // sentence. Warn rather than refuse: the format is Supabase's to change, and
  // a wrong guess here should not ground a working deployment.
  const looksLikeKey = key.startsWith("eyJ") || key.startsWith("sb_secret_");
  if (!looksLikeKey) {
    console.error(
      "[sweep] SUPABASE_SERVICE_ROLE_KEY doesn't look like an API key. Expected a JWT " +
        "starting 'eyJ' or a key starting 'sb_secret_'. The value under Settings → JWT Keys → " +
        "Legacy JWT Secret is the token *signing* secret, not an API key — the one you want is " +
        "under Settings → API Keys, labelled service_role.",
    );
  }

  const db = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // One row per user who owns anything worth checking.
  const { data: owners, error } = await db
    .from("items")
    .select("user_id")
    .eq("enabled", true)
    .returns<{ user_id: string }[]>();
  if (error) {
    // The first query is also the credential test, so say so here rather than
    // letting an auth failure read as a database problem.
    const hint = /jwt|api key|unauthor|invalid/i.test(error.message)
      ? " — this usually means SUPABASE_SERVICE_ROLE_KEY is wrong; check Settings → API Keys"
      : "";
    console.error(`[sweep] couldn't read the watchlist: ${error.message}${hint}`);
    return Response.json({ ok: false, error: error.message + hint }, { status: 500 });
  }

  const userIds = [...new Set((owners ?? []).map((row) => row.user_id))];
  const startedAt = Date.now();
  const report: Record<string, unknown>[] = [];

  for (const userId of userIds) {
    // Share the budget out, so one user with a long list can't starve the rest.
    const spent = Date.now() - startedAt;
    const share = Math.max(2_000, (BUDGET_MS - spent) / Math.max(1, userIds.length));
    // Every query sweepUser makes filters on this user_id explicitly. It has
    // to: the service-role client sees every row, so row level security is not
    // doing that filtering here the way it does for a signed-in session.
    const outcome = await sweepUser(db, userId, { budgetMs: share });
    console.log(
      `[sweep] ${userId}: checked ${outcome.checked}, skipped ${outcome.skipped} ` +
        `(not due yet), ${outcome.remaining} left for next run, ${outcome.alerts} alerts` +
        (outcome.errors.length ? ` — errors: ${outcome.errors.join("; ")}` : ""),
    );
    report.push({ userId, ...outcome });
  }

  // Retention is a once-a-day job riding on the same cron, not a once-every-
  // five-minutes one: it is a delete across the whole history table, and there
  // is nothing to gain from re-running it 288 times a day to remove the same
  // nothing. Scheduled functions run on UTC, so this fires on one tick.
  const now = new Date();
  const pruneWindow = now.getUTCHours() === 4 && now.getUTCMinutes() < 5;
  if (pruneWindow) {
    await pruneHistory(db).catch((pruneError) => {
      console.error("[sweep] prune failed:", pruneError);
    });
  }

  return Response.json({ ok: true, ms: Date.now() - startedAt, pruned: pruneWindow, users: report });
}

export const config: Config = {
  // Every five minutes. Per-item cadence is enforced in sweepUser from each
  // user's own interval setting — this is just the heartbeat that gives it a
  // chance to run.
  schedule: "*/5 * * * *",
};
