import { data, Form, redirect, useSearchParams } from "react-router";

import type { Route } from "./+types/login";
import { allowlistConfigured, getSession, sessionClient, siteOrigin } from "~/lib/supabase.server";

export const meta: Route.MetaFunction = () => [{ title: "Sign in — RESTOCK" }];

export async function loader({ request }: Route.LoaderArgs) {
  const session = await getSession(request);
  if (session) throw redirect("/", { headers: session.headers });
  return { configured: allowlistConfigured() };
}

/**
 * Hand off to Google.
 *
 * Nothing is checked here. With OAuth we don't know who is signing in until
 * Google says so, which means the allowlist can only be applied on the way
 * back — see auth.callback.tsx, and requireUser() for the check that runs on
 * every request afterwards.
 */
export async function action({ request }: Route.ActionArgs) {
  const { db, headers } = sessionClient(request);
  const next = String((await request.formData()).get("next") ?? "/");

  const { data: result, error } = await db.auth.signInWithOAuth({
    provider: "google",
    options: {
      // Must match an entry in Supabase's Redirect URLs exactly, scheme
      // included — see siteOrigin() for why the request's own URL isn't
      // trustworthy for this.
      redirectTo: `${siteOrigin(request)}/auth/callback?next=${encodeURIComponent(next)}`,
    },
  });

  if (error || !result?.url) {
    return data(
      {
        error:
          error?.message ??
          "Couldn't start the Google sign-in. Check that the Google provider is enabled in " +
            "Supabase under Authentication → Sign In / Providers.",
      },
      { headers },
    );
  }

  // `headers` carries the PKCE code verifier Supabase just generated, and the
  // callback cannot complete the sign-in without it. It has to ride along on
  // the redirect as a Headers instance — folding it through
  // Object.fromEntries() would join the repeated Set-Cookie entries into one
  // malformed string, and Supabase chunks its cookies.
  throw redirect(result.url, { headers });
}

export default function Login({ actionData, loaderData }: Route.ComponentProps) {
  const [params] = useSearchParams();
  const next = params.get("next") ?? "/";
  // The callback route reports failures by redirecting here with ?error=, so
  // both sources have to be read — showing only the form's own errors left a
  // failed sign-in looking like a blank page with a mysterious URL.
  const error = actionData?.error ?? params.get("error");

  // Without ALLOWED_EMAILS every account is refused after Google returns,
  // which looks like a baffling bounce. Say it up front instead.
  if (!loaderData.configured) {
    return (
      <main className="wrap-narrow">
        <div className="head-rule">
          <h2>Nobody can sign in yet</h2>
          <p className="sub" style={{ maxWidth: "60ch" }}>
            <span className="mono">ALLOWED_EMAILS</span> isn&rsquo;t set, so every account is
            turned away. Set it to your own Google address — comma-separated for more than one —
            in <span className="mono">.env</span> locally, or under Site configuration →
            Environment variables on Netlify.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="wrap-narrow">
      <div className="head-rule">
        <div
          className="kicker"
          style={{ color: "var(--color-accent-700)", marginBottom: 12, letterSpacing: ".12em" }}
        >
          Restock
        </div>
        <h2>Sign in</h2>
        <p className="sub" style={{ maxWidth: "54ch" }}>
          One account, yours. Everything you watch and every check we&rsquo;ve run is behind this.
        </p>
      </div>

      <Form method="post" className="sec sec-strong">
        <input type="hidden" name="next" value={next} />
        {error ? (
          <p className="err-text" style={{ marginBottom: 16, maxWidth: "54ch" }}>
            {error}
          </p>
        ) : null}
        <button className="btn btn-primary btn-lg" type="submit">
          Continue with Google
        </button>
        <p className="sub" style={{ marginTop: 16, maxWidth: "54ch" }}>
          No password, and no sign-in email to wait for.
        </p>
      </Form>
    </main>
  );
}
