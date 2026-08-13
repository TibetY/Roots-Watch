import {
  data,
  Form,
  isRouteErrorResponse,
  Links,
  Meta,
  NavLink,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteLoaderData,
} from "react-router";

import type { Route } from "./+types/root";
import "./app.css";
import { loadDotEnv, readSettings } from "./lib/settings.server";
import { getSession } from "./lib/supabase.server";

export const links: Route.LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;800&display=swap",
  },
];

export const meta: Route.MetaFunction = () => [
  { title: "RESTOCK — stock watch" },
  {
    name: "description",
    content: "Watches shop pages for the sizes you want and tells you the moment one is back.",
  },
];

/**
 * Root loader tells the header two things: whether anyone is signed in, and
 * whether alerts have somewhere to go.
 *
 * It deliberately does *not* return the webhook URL or ntfy topic. The header
 * only needs the boolean, and anything returned here is embedded in the HTML of
 * every single page — which is how a topic ends up legible in a screenshot of
 * an unrelated screen. An ntfy topic is a credential: anyone holding it can
 * read your alerts and publish to you.
 */
export async function loader({ request }: Route.LoaderArgs) {
  await loadDotEnv();

  const session = await getSession(request);
  if (!session) return { signedIn: false, email: null, hasChannel: false };

  const settings = await readSettings(session.db, session.userId);
  return data(
    { signedIn: true, email: session.email, hasChannel: settings.hasChannel },
    { headers: session.headers },
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

function Header() {
  const root = useRouteLoaderData<typeof loader>("root");

  // Signed out, the only screen is the login one — a nav bar full of links
  // that all bounce back here would just be furniture.
  if (!root?.signedIn) {
    return (
      <header className="topbar">
        <NavLink to="/login" className="brand" end>
          RESTOCK<span>.</span>
        </NavLink>
      </header>
    );
  }

  return (
    <header className="topbar">
      <NavLink to="/" className="brand" end>
        RESTOCK<span>.</span>
      </NavLink>
      <nav className="tabs">
        <NavLink to="/" end>
          Watching
        </NavLink>
        <NavLink to="/add">Add an item</NavLink>
        <NavLink to="/history">History</NavLink>
        <NavLink to="/settings">Settings</NavLink>
        <NavLink to="/console">Console</NavLink>
      </nav>
      <div className="topbar-end">
        <NavLink to="/settings" className="alerts-pill">
          <span className={root.hasChannel ? "dot" : "dot off"} />
          {root.hasChannel ? "Alerts on" : "Alerts off"}
        </NavLink>
        <Form method="post" action="/auth/callback">
          <button className="btn btn-ghost" type="submit" title={root.email ?? undefined}>
            Sign out
          </button>
        </Form>
      </div>
    </header>
  );
}

export default function App() {
  return (
    <>
      <Header />
      <Outlet />
    </>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let heading = "Something broke";
  let detail = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    heading = error.status === 404 ? "No such page" : `Error ${error.status}`;
    detail =
      error.status === 404
        ? "That address doesn't match anything here."
        : error.statusText || detail;
  } else if (import.meta.env.DEV && error instanceof Error) {
    detail = error.message;
    stack = error.stack;
  }

  return (
    <main className="wrap-narrow">
      <div className="head-rule">
        <h2>{heading}</h2>
        <p className="sub">{detail}</p>
      </div>
      {stack && (
        <pre style={{ overflowX: "auto", fontSize: 12, padding: "16px 0" }}>
          <code>{stack}</code>
        </pre>
      )}
      <p style={{ paddingTop: 24 }}>
        <a className="btn btn-secondary" href="/">
          Back to watching
        </a>
      </p>
    </main>
  );
}
