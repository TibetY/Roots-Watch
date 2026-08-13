// A real Postgres to test the schema and the queries against.
//
// pglite is Postgres compiled to WebAssembly, so the migration runs against the
// same planner and type system Supabase will run it against — no Docker, and no
// hand-waving about whether the SQL is valid.
//
// What it doesn't give us is Supabase's `auth` schema, so we stub the two
// pieces the migration depends on: the users table policies reference, and
// auth.uid(). The stub reads a session GUC, which lets a test say "now act as
// this user" and actually exercise the row level security policies.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";

const MIGRATION = resolve(process.cwd(), "supabase/migrations/0001_init.sql");

/** Stand-ins for the parts of Supabase the migration leans on. */
const BOOTSTRAP = `
  create schema if not exists auth;

  create table auth.users (
    id    uuid primary key default gen_random_uuid(),
    email text unique not null
  );

  -- Supabase derives this from the request's JWT. Here it comes from a GUC the
  -- test sets, so as_user() below can switch identities.
  create or replace function auth.uid() returns uuid
  language sql stable as $$
    select nullif(current_setting('test.user_id', true), '')::uuid
  $$;

  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then
      create role authenticated;
    end if;
  end $$;
`;

export type TestDb = {
  pg: PGlite;
  /** Run as this user, so RLS policies apply the way they will in production. */
  asUser: (userId: string | null) => Promise<void>;
  /** Insert a user and return its id. */
  addUser: (email: string) => Promise<string>;
  close: () => Promise<void>;
};

export async function freshDatabase(): Promise<TestDb> {
  const pg = new PGlite();
  await pg.exec(BOOTSTRAP);
  await pg.exec(readFileSync(MIGRATION, "utf8"));

  return {
    pg,
    asUser: async (userId) => {
      await pg.query(`select set_config('test.user_id', $1, false)`, [userId ?? ""]);
    },
    addUser: async (email) => {
      const result = await pg.query<{ id: string }>(
        `insert into auth.users (email) values ($1) returning id`,
        [email],
      );
      return result.rows[0].id;
    },
    close: () => pg.close(),
  };
}
