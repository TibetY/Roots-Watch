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
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
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

export type Session = { db: Db; userId: string; email: string; headers: Headers };

/** The signed-in user, or null. Never throws for "not logged in". */
export async function getSession(request: Request): Promise<Session | null> {
  const { db, headers } = sessionClient(request);
  // getUser() verifies the JWT with the auth server. getSession() only decodes
  // the cookie, which the client could have written itself.
  const { data, error } = await db.auth.getUser();
  if (error || !data.user) return null;
  return { db, userId: data.user.id, email: data.user.email ?? "", headers };
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

/**
 * Full-access client for the scheduled sweep. Bypasses row level security.
 *
 * Called only from the Netlify function, never from a route.
 */
export function serviceClient(): Db {
  return createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
