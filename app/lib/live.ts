// Live updates without polling.
//
// The Watching screen used to revalidate every five seconds. On a laptop that
// cost nothing. Hosted, every one of those is a server function invocation —
// roughly seventeen thousand a day per open tab, for a page that changes every
// ten minutes. Supabase pushes instead: the database tells the browser when a
// row actually changed, and the loader reruns only then.

import { useEffect } from "react";
import { useRevalidator } from "react-router";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

export type PublicEnv = { supabaseUrl: string; supabaseAnonKey: string };

let cached: SupabaseClient | null = null;

/** One browser client per tab. It reads the same session cookie the server set. */
export function browserDb(env: PublicEnv): SupabaseClient {
  cached ??= createBrowserClient(env.supabaseUrl, env.supabaseAnonKey);
  return cached;
}

/**
 * Revalidate whenever a watched row changes.
 *
 * Row level security applies to the subscription too, so this only ever hears
 * about the signed-in user's own rows.
 */
export function useLiveUpdates(env: PublicEnv | null, table = "item_status"): void {
  const revalidator = useRevalidator();

  useEffect(() => {
    if (!env?.supabaseUrl) return;
    const db = browserDb(env);

    const channel = db
      .channel(`restock:${table}`)
      .on("postgres_changes", { event: "*", schema: "public", table }, () => {
        // `state` is checked so a burst of row updates during a sweep coalesces
        // into one reload rather than queueing a dozen.
        if (revalidator.state === "idle") revalidator.revalidate();
      })
      .subscribe();

    return () => {
      db.removeChannel(channel);
    };
  }, [env, table, revalidator]);
}
