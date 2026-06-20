# JoshCards

A phone-friendly card catalogue for Josh & Sylvie. Add Pokemon, Magic, Glade,
custom games, and family card games by name, game, type/colour, cost, tags, and
storage location.

## What it is

- Static web app / PWA: no build step, deploys to Vercel as-is.
- Local-first database in your browser using IndexedDB.
- Name-first card lookup for Pokemon and Magic.
- Optional camera/photo capture, with OCR as an opt-in helper.
- Deck building, legality checks, and playtest exports.
- Optional Supabase sync for sharing one collection across your own devices.

## Use

Open the deployed URL on your phone, then start with **Find by name**. Pick the
matching printing, save it, and add storage/tags as needed. Use **Add manually**
for custom cards or games that do not have an online card database.

Photos are optional. If you turn on "Try reading the card name from photos", the
app will attempt OCR after capture, but typed name lookup is the most reliable
path.

## Playtesting

Build a Pokemon or Magic deck in **Decks**, then use **Playtest / export**.

- MTG plain text works with Forge, Moxfield, and Untap.in.
- MTG Arena export includes set and collector number when known.
- Pokemon export targets Pokemon TCG Live and PTCG-sim.

Older cards may need **Look up** or **Choose art** run again before exports can
include set code and collector number.

## Online Sync

Without setup the app is local-only per device. To share one collection:

1. Create your own Supabase project.
2. In Supabase, run `supabase-setup.sql`.
3. In the app, open **Sync**.
4. Paste your Project URL and anon public key.
5. Use the generated Collection ID on every device that should share the same collection.

The Collection ID keeps separate collections apart inside the same Supabase
project. Keep it private. The included RLS policy is still intentionally simple
for a private family app; for stronger privacy, add Supabase Auth and
authenticated-only policies.

## Deploy

Static site, zero build. On Vercel: Add New -> Project -> import this repo ->
Deploy. Framework preset: Other.

## Files

- `index.html` / `styles.css` / `app.js`: the app
- `catalog-data.js`: editable game and tag lists
- `config.js`: optional built-in sync target
- `manifest.webmanifest` / `sw.js` / `icons/`: PWA install and offline support
- `supabase-setup.sql`: optional sync setup
- `Card-Game-Tracker.xlsx`: original spreadsheet catalogue
