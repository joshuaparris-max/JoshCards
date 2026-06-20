-- JoshCards — Supabase setup. Run this once in your Supabase project:
-- Dashboard → SQL Editor → New query → paste → Run.

create table if not exists public.cards (
  id        text primary key,
  name      text,
  game      text,
  type      text,
  cost      text,
  power     text,
  rarity    text,
  price     numeric,
  qty       integer default 1,
  location  text,
  tags      jsonb default '[]'::jsonb,
  image     text,
  meta      jsonb default '{}'::jsonb,
  updated   timestamptz default now()
);

-- Decks: legal Pokémon / MTG decks built from your catalogue.
create table if not exists public.decks (
  id       text primary key,
  name     text,
  game     text,
  entries  jsonb default '{}'::jsonb,  -- { cardId: count }
  updated  timestamptz default now()
);
alter table public.decks enable row level security;
drop policy if exists "anon all decks" on public.decks;
create policy "anon all decks" on public.decks for all using (true) with check (true);

-- Simple family setup: allow the app's anon key to read/write this one table.
-- (Fine for a private two-person card list. To lock it down later, replace these
--  policies with authenticated-only ones and add Supabase Auth.)
alter table public.cards enable row level security;

drop policy if exists "anon all" on public.cards;
create policy "anon all" on public.cards
  for all using (true) with check (true);
