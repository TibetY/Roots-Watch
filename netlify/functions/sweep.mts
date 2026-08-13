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
 * Netlify stops a scheduled function well before this matters for a short
 * watchlist; the budget is here so a long one degrades into "checked the
 * stalest few, will get the rest in five minutes" instead of being killed
 * halfway through writing a result.
 */
const BUDGET_MS = 20_000;

export default async function sweep(): Promise<Response> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return Response.json(
      { ok: false, error: "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set" },
      { status: 500 },
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
    return Response.json({ ok: false, error: error.message }, { status: 500 });
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
    report.push({ userId, ...(await sweepUser(db, userId, { budgetMs: share })) });
  }

  await pruneHistory(db).catch((pruneError) => {
    console.error("[sweep] prune failed:", pruneError);
  });

  return Response.json({ ok: true, ms: Date.now() - startedAt, users: report });
}

export const config: Config = {
  // Every five minutes. Per-item cadence is enforced in sweepUser from each
  // user's own interval setting — this is just the heartbeat that gives it a
  // chance to run.
  schedule: "*/5 * * * *",
};
