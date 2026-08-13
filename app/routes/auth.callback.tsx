import { redirect } from "react-router";

import type { Route } from "./+types/auth.callback";
import { isAllowed, sessionClient } from "~/lib/supabase.server";

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

  // Supabase reports its own refusals here before we ever see a code — an
  // expired link, a disabled signup, a redirect URL that isn't allowlisted.
  const supabaseError = url.searchParams.get("error_description") ?? url.searchParams.get("error");
  if (supabaseError) {
    throw redirect(`/login?error=${encodeURIComponent(supabaseError)}`);
  }

  if (!code) {
    // No code and no error means the tokens came back in the URL fragment,
    // which a server loader cannot see. That happens when the redirect URL
    // isn't the one Supabase was told to use.
    throw redirect(
      `/login?error=${encodeURIComponent(
        "The sign-in came back without a code. Check that this site's /auth/callback URL is " +
          "listed under Authentication → URL Configuration → Redirect URLs in Supabase.",
      )}`,
    );
  }

  const { db, headers } = sessionClient(request);
  const { data: exchanged, error } = await db.auth.exchangeCodeForSession(code);
  if (error) {
    // Report what actually failed. Calling everything "expired" sent me
    // hunting for a stale link when the real fault was a dropped cookie.
    const detail = /verifier|code challenge/i.test(error.message)
      ? "The sign-in couldn't be completed in this browser — start again, and finish in the " +
        "same browser you started from."
      : error.message;
    throw redirect(`/login?error=${encodeURIComponent(detail)}`);
  }

  // Google has vouched for who they are; whether we accept them is ours to
  // decide. Checked here so the refusal can be explained at the moment it
  // happens — requireUser() enforces the same rule on every later request.
  const email = exchanged.user?.email ?? "";
  if (!isAllowed(email)) {
    await db.auth.signOut().catch(() => {});
    throw redirect(
      `/login?error=${encodeURIComponent(
        `${email || "That account"} isn't on the allowlist for this deployment.`,
      )}`,
    );
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
