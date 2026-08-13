import { redirect } from "react-router";

import type { Route } from "./+types/auth.callback";
import { sessionClient } from "~/lib/supabase.server";

/**
 * Where the emailed link lands.
 *
 * Supabase sends a one-time `code` which is exchanged here for a session, and
 * the resulting Set-Cookie headers have to ride along on the redirect — drop
 * them and the user bounces straight back to the login screen having done
 * everything right.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") || "/";

  if (!code) throw redirect("/login");

  const { db, headers } = sessionClient(request);
  const { error } = await db.auth.exchangeCodeForSession(code);
  if (error) {
    throw redirect(`/login?error=${encodeURIComponent("That link has expired. Try another.")}`);
  }

  // Only ever redirect somewhere inside this app: `next` arrives from a URL and
  // an open redirect is an open redirect even behind a login.
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  throw redirect(safeNext, { headers });
}

export async function action({ request }: Route.ActionArgs) {
  // Sign out lives here too — it needs the same cookie plumbing.
  const { db, headers } = sessionClient(request);
  await db.auth.signOut();
  throw redirect("/login", { headers });
}
