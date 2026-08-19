// Supabase clients, and the difference between them.
//
// There are two, and mixing them up is the one mistake here with real
// consequences:
//
//   * sessionClient — carries the signed-in user's cookie. Every query it runs
//     is filtered by row level security to that user's rows. This is what the
//     routes use.
//   * serviceClient — the service-role key, which bypasses RLS entirely. Only
//     the scheduled sweep uses it, because it runs with no user to be. The key
//     must never reach a browser: it is read from the environment on the
//     server, and nothing in app/ ships it to the client.
//
// Everything the browser is allowed to know goes through publicEnv().

import { createServerClient, parseCookieHeader, serializeCookieHeader } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { redirect } from "react-router";

export type Db = SupabaseClient;

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env and fill in your Supabase project's values.`,
    );
  }
  return value;
}

/** The only two values safe to hand the browser. The anon key is meant to be public. */
export function publicEnv(): { supabaseUrl: string; supabaseAnonKey: string } {
  return {
    supabaseUrl: required("SUPABASE_URL"),
    supabaseAnonKey: required("SUPABASE_ANON_KEY"),
  };
}

/**
 * A client bound to this request's session.
 *
 * The returned `headers` must be spread onto the response — Supabase rotates
 * the refresh token during `getUser()`, and dropping the Set-Cookie it wants to
 * write logs the user out an hour later for no visible reason.
 */
export function sessionClient(request: Request): { db: Db; headers: Headers } {
  const headers = new Headers();
  const { supabaseUrl, supabaseAnonKey } = publicEnv();

  const db = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return parseCookieHeader(request.headers.get("Cookie") ?? "").map((cookie) => ({
          name: cookie.name,
          value: cookie.value ?? "",
        }));
      },
      setAll(cookies) {
        for (const { name, value, options } of cookies) {
          headers.append("Set-Cookie", serializeCookieHeader(name, value, options));
        }
      },
    },
  });

  return { db, headers };
}

/**
 * Who may use this deployment, by email address.
 *
 * This is the only access check fully under our control, so it runs on every
 * request rather than once at the door. The alternatives all have holes:
 * checking it only in the login route is bypassed by any other way of
 * obtaining a session, and Supabase's own "allow new users to sign up" toggle
 * governs account creation rather than who may sign in with an account that
 * already exists.
 *
 * An empty list refuses everyone. A misconfiguration should fail shut.
 */
export function allowedEmails(): string[] {
  return (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export function allowlistConfigured(): boolean {
  return allowedEmails().length > 0;
}

export function isAllowed(email: string | null | undefined): boolean {
  const list = allowedEmails();
  if (!list.length) return false;
  return list.includes(String(email ?? "").trim().toLowerCase());
}

export type Session = { db: Db; userId: string; email: string; headers: Headers };

/**
 * The signed-in, allowed user — or null. Never throws for "not logged in".
 *
 * A session belonging to an address that isn't on the allowlist is torn down
 * here rather than merely ignored: leaving it in place would let someone sit
 * on a valid cookie indefinitely, and every request would pay to re-discover
 * that they aren't welcome.
 */
export async function getSession(request: Request): Promise<Session | null> {
  const { db, headers } = sessionClient(request);
  // getUser() verifies the JWT with the auth server. getSession() only decodes
  // the cookie, which the client could have written itself.
  const { data, error } = await db.auth.getUser();
  if (error || !data.user) return null;

  const email = data.user.email ?? "";
  if (!isAllowed(email)) {
    await db.auth.signOut().catch(() => {});
    return null;
  }

  return { db, userId: data.user.id, email, headers };
}

/** The signed-in user, or a redirect to the login screen. */
export async function requireUser(request: Request): Promise<Session> {
  const session = await getSession(request);
  if (!session) {
    const url = new URL(request.url);
    const next = url.pathname + url.search;
    throw redirect(`/login?next=${encodeURIComponent(next)}`);
  }
  return session;
}

// There is deliberately no service-role client in here.
//
// The scheduled sweep builds its own, in netlify/functions/sweep.mts, from the
// environment it runs in. Exporting one from a module that routes import would
// put an RLS-bypassing client one autocomplete away from a loader — and a
// route that reached for it would read every user's rows while looking
// entirely ordinary. The only code that needs it is the code that has no user
// to act as.
