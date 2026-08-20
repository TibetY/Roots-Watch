-- Why a watch was stopped, in the watcher's own words.
--
-- Everything else in this schema records what the machine observed. This one
-- records what the person said, which is a different kind of fact and worth
-- keeping apart from the rest: a restock we detected is evidence, "I found it
-- because of this" is testimony.
--
-- The item reference is deliberately ON DELETE SET NULL rather than CASCADE,
-- unlike every other table here. An outcome is a fact about something that
-- already happened; removing the watch afterwards does not un-happen it. If it
-- cascaded, the tally would quietly shrink every time you tidied the list —
-- and the one number people look at would silently be wrong. The label and url
-- are snapshotted for the same reason: the row has to still mean something
-- once the item it points at is gone.

create table if not exists public.outcomes (
  id      bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  item_id uuid references public.items (id) on delete set null,
  label   text,
  url     text,
  at      timestamptz not null default now(),
  reason  text not null check (reason in ('found_here', 'found_elsewhere', 'no_longer_want'))
);

create index if not exists outcomes_user_at_idx on public.outcomes (user_id, at desc);

alter table public.outcomes enable row level security;

drop policy if exists outcomes_own on public.outcomes;
create policy outcomes_own on public.outcomes for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
