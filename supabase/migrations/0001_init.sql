-- Restock — schema.
--
-- Everything the app used to keep in files under data/ lives here instead,
-- because Netlify's filesystem is read-only and its functions have no memory
-- between invocations. Four things moved:
--
--   data/watchlist.json        -> items
--   data/watch-state/<id>.json -> alert_state + blind_state
--   data/history/<id>.json     -> checks + events
--   .env (written by Settings) -> settings
--
-- Two deliberate changes rather than straight ports:
--
--   * `checks` stores one row per check instead of the hourly rollups the file
--     format used. Rollups existed to keep a JSON file from growing to 4,000
--     lines a month; Postgres has no such problem, and rows make coverage exact
--     instead of hour-granular.
--   * Every table carries user_id, even the ones reachable only through an
--     item. It's denormalised on purpose: an RLS policy that can check
--     ownership without a join is one that can't be got wrong later.

-- gen_random_uuid() is core Postgres from 13 on, so no pgcrypto needed.

-- ── watchlist ─────────────────────────────────────────────────────────────
create table if not exists public.items (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  label          text,
  url            text not null,
  sizes          text[] not null default '{}',
  renotify_hours integer not null default 6 check (renotify_hours > 0),
  duration_days  integer not null default 0 check (duration_days >= 0),
  expires_at     timestamptz,
  enabled        boolean not null default true,
  created_at     timestamptz not null default now(),
  -- The watcher fetches whatever this points at, so keep it to real web pages.
  constraint items_url_is_http check (url ~* '^https?://')
);

create index if not exists items_user_idx on public.items (user_id, created_at);

-- ── latest result per item (was the in-memory status Map) ─────────────────
create table if not exists public.item_status (
  item_id      uuid primary key references public.items (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  checked_at   timestamptz not null,
  -- When we last actually read the page, as opposed to last tried.
  last_good_at timestamptz,
  product      text,
  image        text,
  price        text,
  currency     text,
  source       text not null default 'none',
  confidence   text not null default 'low',
  error        text,
  sizes        jsonb not null default '[]'::jsonb,
  alerted      text[] not null default '{}',
  buy_link     text,
  checking     boolean not null default false,
  -- The last set of sizes we *knew* were in stock, carried across blind checks.
  -- Without it, recovering from an outage reports everything that was already
  -- in stock as a brand-new restock.
  last_in_stock text[] not null default '{}',
  last_blind    boolean not null default false,
  last_price    text
);

-- ── alert dedupe (was data/watch-state/<id>.json) ─────────────────────────
create table if not exists public.alert_state (
  item_id     uuid not null references public.items (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  size        text not null,
  status      text not null,
  seen_at     timestamptz not null,
  notified_at timestamptz,
  primary key (item_id, size)
);

create table if not exists public.blind_state (
  item_id          uuid primary key references public.items (id) on delete cascade,
  user_id          uuid not null references auth.users (id) on delete cascade,
  blind_runs       integer not null default 0,
  blind_since      timestamptz,
  blind_alert_sent boolean not null default false
);

-- ── history ───────────────────────────────────────────────────────────────
-- One row per check. `ok` is the load-bearing column: an hour with no ok row
-- is an hour we could not see, which is what separates "it never restocked"
-- from "nobody was looking".
create table if not exists public.checks (
  id       bigint generated always as identity primary key,
  item_id  uuid not null references public.items (id) on delete cascade,
  user_id  uuid not null references auth.users (id) on delete cascade,
  at       timestamptz not null default now(),
  ok       boolean not null,
  in_stock text[] not null default '{}',
  price    text,
  error    text
);

create index if not exists checks_item_at_idx on public.checks (item_id, at desc);

create table if not exists public.events (
  id         bigint generated always as identity primary key,
  item_id    uuid not null references public.items (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  at         timestamptz not null default now(),
  kind       text not null check (kind in ('drop', 'gone', 'blind', 'clear', 'price')),
  sizes      text[] not null default '{}',
  price      text,
  price_from text,
  price_to   text,
  alerted    boolean not null default false,
  reason     text
);

create index if not exists events_item_at_idx on public.events (item_id, at desc);

-- ── settings (was .env, rewritten in place by the Settings screen) ────────
create table if not exists public.settings (
  user_id          uuid primary key references auth.users (id) on delete cascade,
  webhook_url      text not null default '',
  webhook_topic    text not null default '',
  interval_minutes integer not null default 10 check (interval_minutes > 0),
  auto_run         boolean not null default true,
  -- The app used to run on your laptop, so "today" meant your today. On a
  -- server it means UTC unless we say otherwise, which would put every
  -- evening restock on the wrong day of the history strip.
  timezone         text not null default 'UTC',
  updated_at       timestamptz not null default now()
);

-- ── row level security ────────────────────────────────────────────────────
-- The service-role key used by the scheduled function bypasses all of this;
-- anything reached with a user's session key is confined to their own rows.
alter table public.items       enable row level security;
alter table public.item_status enable row level security;
alter table public.alert_state enable row level security;
alter table public.blind_state enable row level security;
alter table public.checks      enable row level security;
alter table public.events      enable row level security;
alter table public.settings    enable row level security;

do $$
declare
  target text;
begin
  foreach target in array array[
    'items', 'item_status', 'alert_state', 'blind_state', 'checks', 'events'
  ] loop
    execute format('drop policy if exists %I on public.%I', target || '_own', target);
    execute format(
      'create policy %I on public.%I for all to authenticated
         using (user_id = auth.uid()) with check (user_id = auth.uid())',
      target || '_own', target
    );
  end loop;
end $$;

drop policy if exists settings_own on public.settings;
create policy settings_own on public.settings for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ── realtime ──────────────────────────────────────────────────────────────
-- The Watching screen subscribes to this table instead of polling. Polling
-- every five seconds was fine against a laptop; against a hosted function it's
-- an invocation every five seconds per open tab, which is most of a free tier
-- spent on asking "anything yet?".
--
-- Guarded so this migration still runs somewhere without Supabase's publication
-- — the test database, for one.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'item_status'
     )
  then
    execute 'alter publication supabase_realtime add table public.item_status';
  end if;
end $$;

-- ── retention ─────────────────────────────────────────────────────────────
-- Matches RETAIN_DAYS in app/lib/stats.ts. Called by the sweep, so it needs no
-- scheduler of its own.
create or replace function public.prune_history(retain_days integer default 90)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.checks where at < now() - make_interval(days => retain_days);
  delete from public.events where at < now() - make_interval(days => retain_days);
$$;

-- ── hourly coverage ───────────────────────────────────────────────────────
-- Rolls checks up the way app/lib/stats.ts wants them: one row per local hour,
-- with how many checks ran and how many could read the page. Bucketing happens
-- in the caller's timezone, because "which day did that restock land on" is a
-- question about their calendar, not the server's.
--
-- Returns the day as text and the hour as an integer rather than a timestamp.
-- A `timestamp without time zone` gets re-read as local time by every client
-- driver on the way out, which would silently shift every bucket by the
-- server's offset — the exact bug this function exists to prevent.
create or replace function public.hourly_coverage(
  p_item_id uuid,
  p_from    timestamptz,
  p_zone    text default 'UTC'
)
returns table (day text, hour integer, checks bigint, reads bigint, hits bigint)
language sql
stable
as $$
  select
    to_char(c.at at time zone p_zone, 'YYYY-MM-DD')          as day,
    extract(hour from c.at at time zone p_zone)::integer     as hour,
    count(*)                                                 as checks,
    count(*) filter (where c.ok)                             as reads,
    count(*) filter (where c.ok and cardinality(c.in_stock) > 0) as hits
  from public.checks c
  where c.item_id = p_item_id
    and c.at >= p_from
  group by 1, 2
  order by 1, 2
$$;
