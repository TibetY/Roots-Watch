// The schema, executed. Every assertion here is Postgres answering, not me
// guessing what Postgres would say.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { freshDatabase, type TestDb } from "./helpers/pg";

let db: TestDb;
let alice: string;
let bob: string;

beforeAll(async () => {
  db = await freshDatabase();
  alice = await db.addUser("alice@example.com");
  bob = await db.addUser("bob@example.com");
}, 60_000);

afterAll(async () => {
  await db?.close();
});

async function itemFor(userId: string, url = "https://shop.example/thing.html") {
  const result = await db.pg.query<{ id: string }>(
    `insert into public.items (user_id, url, sizes) values ($1, $2, $3) returning id`,
    [userId, url, ["3", "5"]],
  );
  return result.rows[0].id;
}

describe("migration", () => {
  it("creates every table the app needs", async () => {
    const result = await db.pg.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public' order by tablename`,
    );
    expect(result.rows.map((row) => row.tablename)).toEqual([
      "alert_state",
      "blind_state",
      "checks",
      "events",
      "item_status",
      "items",
      "settings",
    ]);
  });

  it("turns row level security on for all of them", async () => {
    const result = await db.pg.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class
       where relnamespace = 'public'::regnamespace and relkind = 'r' order by relname`,
    );
    expect(result.rows.every((row) => row.relrowsecurity)).toBe(true);
    expect(result.rows).toHaveLength(7);
  });

  it("refuses a url that isn't http(s)", async () => {
    await expect(
      db.pg.query(`insert into public.items (user_id, url) values ($1, $2)`, [
        alice,
        "file:///etc/passwd",
      ]),
    ).rejects.toThrow(/items_url_is_http/);
  });

  it("takes an item's history down with it", async () => {
    const item = await itemFor(alice);
    await db.pg.query(`insert into public.checks (item_id, user_id, ok) values ($1, $2, true)`, [
      item,
      alice,
    ]);
    await db.pg.query(`insert into public.events (item_id, user_id, kind) values ($1, $2, 'drop')`, [
      item,
      alice,
    ]);

    await db.pg.query(`delete from public.items where id = $1`, [item]);

    const checks = await db.pg.query(`select 1 from public.checks where item_id = $1`, [item]);
    const events = await db.pg.query(`select 1 from public.events where item_id = $1`, [item]);
    expect(checks.rows).toHaveLength(0);
    expect(events.rows).toHaveLength(0);
  });

  it("only accepts event kinds the app actually writes", async () => {
    const item = await itemFor(alice);
    await expect(
      db.pg.query(`insert into public.events (item_id, user_id, kind) values ($1, $2, 'restock')`, [
        item,
        alice,
      ]),
    ).rejects.toThrow(/events_kind_check/);
  });
});

describe("row level security", () => {
  it("hides one user's watchlist from another", async () => {
    const aliceItem = await itemFor(alice, "https://shop.example/alice.html");
    await itemFor(bob, "https://shop.example/bob.html");

    // Policies apply to `authenticated`, not to the superuser the tests run as,
    // so step down to the same role Supabase gives a logged-in session.
    await db.pg.exec(`grant usage on schema public to authenticated;
                      grant all on all tables in schema public to authenticated;
                      set role authenticated;`);

    await db.asUser(alice);
    const mine = await db.pg.query<{ id: string; user_id: string }>(
      `select id, user_id from public.items`,
    );
    expect(mine.rows.map((row) => row.id)).toContain(aliceItem);
    expect(mine.rows.every((row) => row.user_id === alice)).toBe(true);

    await db.asUser(bob);
    const theirs = await db.pg.query<{ id: string; user_id: string }>(
      `select id, user_id from public.items`,
    );
    expect(theirs.rows.map((row) => row.id)).not.toContain(aliceItem);
    expect(theirs.rows.every((row) => row.user_id === bob)).toBe(true);

    // And Bob cannot reach across by guessing an id.
    const reached = await db.pg.query(`select id from public.items where id = $1`, [aliceItem]);
    expect(reached.rows).toHaveLength(0);

    await db.pg.exec(`reset role;`);
  });

  it("will not let a session write a row owned by someone else", async () => {
    await db.pg.exec(`set role authenticated;`);
    await db.asUser(bob);
    await expect(
      db.pg.query(`insert into public.items (user_id, url) values ($1, $2)`, [
        alice,
        "https://shop.example/forged.html",
      ]),
    ).rejects.toThrow(/row-level security/i);
    await db.pg.exec(`reset role;`);
  });
});

describe("hourly_coverage", () => {
  it("buckets checks into local hours and counts what could be read", async () => {
    const item = await itemFor(alice, "https://shop.example/coverage.html");
    // Three checks in one UTC hour, one of them blind; one the hour after.
    await db.pg.query(
      `insert into public.checks (item_id, user_id, at, ok, in_stock) values
         ($1, $2, '2026-08-01T10:05:00Z', true,  '{}'),
         ($1, $2, '2026-08-01T10:35:00Z', true,  '{4}'),
         ($1, $2, '2026-08-01T10:55:00Z', false, '{}'),
         ($1, $2, '2026-08-01T11:05:00Z', true,  '{}')`,
      [item, alice],
    );

    const utc = await db.pg.query<{
      day: string;
      hour: number;
      checks: bigint;
      reads: bigint;
      hits: bigint;
    }>(`select * from public.hourly_coverage($1, $2, $3)`, [
      item,
      "2026-08-01T00:00:00Z",
      "UTC",
    ]);

    expect(utc.rows).toHaveLength(2);
    expect(utc.rows[0]).toMatchObject({ day: "2026-08-01", hour: 10 });
    expect(Number(utc.rows[0].checks)).toBe(3);
    expect(Number(utc.rows[0].reads)).toBe(2);
    expect(Number(utc.rows[0].hits)).toBe(1);
    expect(utc.rows[1]).toMatchObject({ day: "2026-08-01", hour: 11 });
    expect(Number(utc.rows[1].checks)).toBe(1);
  });

  it("shifts the buckets when asked for a different timezone", async () => {
    const item = await itemFor(alice, "https://shop.example/zone.html");
    await db.pg.query(
      `insert into public.checks (item_id, user_id, at, ok) values ($1, $2, '2026-08-02T01:30:00Z', true)`,
      [item, alice],
    );

    const utc = await db.pg.query<{ day: string; hour: number }>(
      `select * from public.hourly_coverage($1, $2, 'UTC')`,
      [item, "2026-08-01T00:00:00Z"],
    );
    const toronto = await db.pg.query<{ day: string; hour: number }>(
      `select * from public.hourly_coverage($1, $2, 'America/Toronto')`,
      [item, "2026-08-01T00:00:00Z"],
    );

    // 01:30 UTC is still the 1st, 9pm, in Toronto — the whole reason the
    // timezone is stored rather than assumed.
    expect(utc.rows[0]).toMatchObject({ day: "2026-08-02", hour: 1 });
    expect(toronto.rows[0]).toMatchObject({ day: "2026-08-01", hour: 21 });
  });
});

describe("prune_history", () => {
  it("drops checks and events past the retention window, and nothing newer", async () => {
    const item = await itemFor(alice, "https://shop.example/prune.html");
    await db.pg.query(
      `insert into public.checks (item_id, user_id, at, ok) values
         ($1, $2, now() - interval '120 days', true),
         ($1, $2, now() - interval '10 days',  true)`,
      [item, alice],
    );
    await db.pg.query(
      `insert into public.events (item_id, user_id, at, kind) values
         ($1, $2, now() - interval '120 days', 'drop'),
         ($1, $2, now() - interval '10 days',  'drop')`,
      [item, alice],
    );

    await db.pg.query(`select public.prune_history(90)`);

    const checks = await db.pg.query(`select at from public.checks where item_id = $1`, [item]);
    const events = await db.pg.query(`select at from public.events where item_id = $1`, [item]);
    expect(checks.rows).toHaveLength(1);
    expect(events.rows).toHaveLength(1);
  });
});
