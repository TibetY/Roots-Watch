import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";

import type { Route } from "./+types/console";
import { CONSOLE_HELP, runConsoleCommand, type ConsoleLine } from "~/lib/console.server";
import { requireUser } from "~/lib/supabase.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  return { help: CONSOLE_HELP };
}

export async function action({ request }: Route.ActionArgs) {
  const { db, userId } = await requireUser(request);
  const form = await request.formData();
  const command = String(form.get("command") ?? "");
  try {
    const lines = await runConsoleCommand(db, userId, command);
    return { command, lines }; // lines === null means "clear"
  } catch (error) {
    return {
      command,
      lines: [{ text: (error as Error).message, kind: "err" }] as ConsoleLine[],
    };
  }
}

const GREETING: ConsoleLine[] = [
  { text: "stdby console — driving the real watcher", kind: "dim" },
  { text: "`help` for commands. `check` really fetches, and really alerts.", kind: "dim" },
  { text: "", kind: "dim" },
];

export default function ConsoleScreen({ loaderData }: Route.ComponentProps) {
  const { help } = loaderData;
  const runner = useFetcher<{ command: string; lines: ConsoleLine[] | null }>();

  const [lines, setLines] = useState<ConsoleLine[]>(GREETING);
  const [command, setCommand] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyAt, setHistoryAt] = useState(-1);

  const inputRef = useRef<HTMLInputElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const lastHandled = useRef<unknown>(null);

  // Append whatever the server returned, once per response.
  useEffect(() => {
    if (!runner.data || runner.data === lastHandled.current) return;
    lastHandled.current = runner.data;
    const { command: ran, lines: result } = runner.data;
    if (result === null) {
      setLines([]);
      return;
    }
    setLines((prev) => [
      ...prev,
      { text: `stdby ❯ ${ran}`, kind: "cmd" },
      ...result,
      { text: "", kind: "dim" },
    ]);
  }, [runner.data]);

  useEffect(() => {
    if (paneRef.current) paneRef.current.scrollTop = paneRef.current.scrollHeight;
  }, [lines, runner.state]);

  function run(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) return;
    setHistory((prev) => [...prev, trimmed]);
    setHistoryAt(-1);
    setCommand("");
    runner.submit({ command: trimmed }, { method: "post" });
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      run(command);
      return;
    }
    // Shell-style history on the arrow keys.
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!history.length) return;
      const next = historyAt < 0 ? history.length - 1 : Math.max(0, historyAt - 1);
      setHistoryAt(next);
      setCommand(history[next]);
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (historyAt < 0) return;
      const next = historyAt + 1;
      if (next >= history.length) {
        setHistoryAt(-1);
        setCommand("");
      } else {
        setHistoryAt(next);
        setCommand(history[next]);
      }
    }
  }

  const busy = runner.state !== "idle";

  return (
    <main className="wrap">
      <div className="page-head" style={{ borderBottom: "2px solid var(--color-divider)" }}>
        <div>
          <div
            className="kicker"
            style={{ color: "var(--color-accent-700)", marginBottom: 12, letterSpacing: ".12em" }}
          >
            For the hacky
          </div>
          <h2>Console</h2>
          <p className="sub" style={{ maxWidth: "62ch" }}>
            The same watcher, driven by hand. Everything you type here changes the real thing —
            sizes, cadence, alerts. Try <span className="mono">help</span>.
          </p>
        </div>
      </div>

      <div className="console-grid">
        <div className="console" ref={paneRef} onClick={() => inputRef.current?.focus()}>
          {lines.map((line, index) => (
            <div key={index} className={`console-line ${line.kind}`}>
              {line.text || " "}
            </div>
          ))}
          {busy ? <div className="console-line dim">…</div> : null}
          <div className="console-prompt">
            <span className="caret">stdby ❯</span>
            <input
              ref={inputRef}
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder="type a command"
              spellCheck={false}
              autoComplete="off"
              aria-label="Console command"
              disabled={busy}
            />
          </div>
        </div>

        <aside className="console-aside">
          <div className="kicker" style={{ marginBottom: 16 }}>
            Commands
          </div>
          {help.map((entry) => (
            <div key={entry.cmd} className="cmd-row">
              <div className="cmd-line">
                <button type="button" onClick={() => run(entry.cmd)} disabled={busy}>
                  {entry.cmd}
                </button>
                {entry.alt ? (
                  <button type="button" onClick={() => run(entry.alt!)} disabled={busy}>
                    {entry.alt}
                  </button>
                ) : null}
              </div>
              <div>{entry.desc}</div>
            </div>
          ))}
        </aside>
      </div>

      <div className="exit-codes">
        <div>
          <div className="code">0</div>
          <p>Nothing in stock.</p>
        </div>
        <div>
          <div className="code">10</div>
          <p>Something is. The alert has already gone out.</p>
        </div>
        <div>
          <div className="code">20</div>
          <p>Couldn&rsquo;t tell. Never reported as sold out.</p>
        </div>
      </div>

      <p style={{ margin: "22px 0 64px", fontSize: 13, color: "var(--color-neutral-700)", maxWidth: "70ch" }}>
        These run server-side against the same watchlist the other screens use — <span className="mono">ls</span>{" "}
        numbers a watch, and every other command takes that number.
      </p>
    </main>
  );
}
