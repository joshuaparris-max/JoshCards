-- JoshCards migration: bring an OLD table up to the current schema.
-- Safe to run on an existing project — it only adds what's missing and
-- keeps your existing rows (they default to the 'default' collection).
-- Supabase -> SQL Editor -> New query -> paste -> Run.

-- ---- cards ----
create table if not exists public.cards (
  id text primary key
);

alter table public.cards add column if not exists collection_id text not null default 'default';
alter table public.cards add column if not exists name        text;
alter table public.cards add column if not exists game        text;
alter table public.cards add column if not exists type        text;
alter table public.cards add column if not exists cost        text;
alter table public.cards add column if not exists power       text;
alter table public.cards add column if not exists rarity      text;
alter table public.cards add column if not exists price       numeric;
alter table public.cards add column if not exists qty         integer default 1;
alter table public.cards add column if not exists location    text;
alter table public.cards add column if not exists tags        jsonb default '[]'::jsonb;
alter table public.cards add column if not exists image       text;
alter table public.cards add column if not exists meta        jsonb default '{}'::jsonb;
alter table public.cards add column if not exists updated     timestamptz default now();

-- switch the primary key to (collection_id, id) so upserts on that key work
alter table public.cards drop constraint if exists cards_pkey;
alter table public.cards add primary key (collection_id, id);

-- ---- decks ----
create table if not exists public.decks (
  id text primary key
);

alter table public.decks add column if not exists collection_id text not null default 'default';
alter table public.decks add column if not exists name        text;
alter table public.decks add column if not exists game        text;
alter table public.decks add column if not exists entries     jsonb default '{}'::jsonb;
alter table public.decks add column if not exists updated     timestamptz default now();

alter table public.decks drop constraint if exists decks_pkey;
alter table public.decks add primary key (collection_id, id);

-- ---- access policies (simple, for a private family collection) ----
alter table public.cards enable row level security;
alter table public.decks enable row level security;

drop policy if exists "anon collection cards" on public.cards;
create policy "anon collection cards" on public.cards for all using (true) with check (true);

drop policy if exists "anon collection decks" on public.decks;
create policy "anon collection decks" on public.decks for all using (true) with check (true);
