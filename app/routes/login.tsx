import { Form, redirect, useSearchParams } from "react-router";

import type { Route } from "./+types/login";
import { getSession, sessionClient } from "~/lib/supabase.server";

export const meta: Route.MetaFunction = () => [{ title: "Sign in — RESTOCK" }];

/**
 * Only these addresses may sign in.
 *
 * Supabase will happily create an account for anyone who asks for a magic
 * link, so "just me" has to be enforced somewhere. Here is the right place:
 * before the link is ever sent, rather than after someone already has a
 * session. Comma-separated, set in the environment.
 */
function allowed(email: string): boolean {
  const list = (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  // An empty list means the deployment hasn't been locked down yet. Refuse
  // rather than let anyone in — a misconfiguration shouldn't open the door.
  if (!list.length) return false;
  return list.includes(email.trim().toLowerCase());
}

export async function loader({ request }: Route.LoaderArgs) {
  const session = await getSession(request);
  if (session) throw redirect("/", { headers: session.headers });
  return { configured: Boolean(process.env.ALLOWED_EMAILS) };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim();
  const next = String(form.get("next") ?? "/");

  if (!email) return { error: "Enter your email address." };

  if (!allowed(email)) {
    // Deliberately the same answer as success. Telling a stranger "that
    // address isn't allowed" confirms which addresses are.
    return { sent: true };
  }

  const { db, headers } = sessionClient(request);
  const origin = new URL(request.url).origin;
  const { error } = await db.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}`,
    },
  });

  if (error) return { error: error.message };
  return new Response(JSON.stringify({ sent: true }), {
    headers: { ...Object.fromEntries(headers), "Content-Type": "application/json" },
  });
}

export default function Login({ actionData }: Route.ComponentProps) {
  const [params] = useSearchParams();
  const next = params.get("next") ?? "/";
  const sent = actionData && "sent" in actionData && actionData.sent;
  const error = actionData && "error" in actionData ? actionData.error : null;

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
          No password. Put in your address and we&rsquo;ll email you a link that signs you in.
        </p>
      </div>

      {sent ? (
        <div className="sec sec-strong">
          <h4>Check your email</h4>
          <p className="sub" style={{ margin: 0 }}>
            If that address has access, a sign-in link is on its way. It&rsquo;s good for one use.
          </p>
        </div>
      ) : (
        <Form method="post" className="sec sec-strong">
          <input type="hidden" name="next" value={next} />
          <label className="kicker" htmlFor="email" style={{ display: "block", marginBottom: 8 }}>
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            className="input"
            placeholder="you@example.com"
            autoComplete="email"
            required
            style={{ marginBottom: 16 }}
          />
          {error ? <p className="err-text" style={{ marginBottom: 12 }}>{error}</p> : null}
          <button className="btn btn-primary btn-lg" type="submit">
            Email me a link
          </button>
        </Form>
      )}
    </main>
  );
}
