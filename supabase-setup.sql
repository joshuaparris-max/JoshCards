-- JoshCards Supabase setup. Run this once in your own Supabase project:
-- Dashboard -> SQL Editor -> New query -> paste -> Run.
--
-- The app is local-only by default. If you enable sync, each device must use
-- the same Supabase URL, anon key, and private Collection ID.

create table if not exists public.cards (
  collection_id text not null default 'default',
  id            text not null,
  name          text,
  game          text,
  type          text,
  cost          text,
  power         text,
  rarity        text,
  price         numeric,
  qty           integer default 1,
  location      text,
  tags          jsonb default '[]'::jsonb,
  image         text,
  meta          jsonb default '{}'::jsonb,
  updated       timestamptz default now(),
  primary key (collection_id, id)
);

create table if not exists public.decks (
  collection_id text not null default 'default',
  id            text not null,
  name          text,
  game          text,
  entries       jsonb default '{}'::jsonb,
  updated       timestamptz default now(),
  primary key (collection_id, id)
);

alter table public.cards enable row level security;
alter table public.decks enable row level security;

drop policy if exists "anon collection cards" on public.cards;
create policy "anon collection cards" on public.cards
  for all using (true) with check (true);

drop policy if exists "anon collection decks" on public.decks;
create policy "anon collection decks" on public.decks
  for all using (true) with check (true);

-- If you previously ran the old setup with "id" as the only primary key,
-- create a fresh Supabase project/table or migrate the primary key before using
-- Collection IDs from multiple devices.
