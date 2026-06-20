# JoshCards

A phone-friendly card catalogue for Josh & Sylvie. Scan any card (Pokémon, Magic, Glade, custom games) with your phone camera and add it to a searchable database — by name, game, colour/type, cost, tags, and storage location.

## What it is
- **Static web app / PWA** — no server, no accounts, no cost. Deploys to Vercel as-is.
- **Camera capture** via the browser (`getUserMedia`) + photo/file fallback.
- **Local database** in your browser (IndexedDB). Data lives on the device that scanned it.
- **Add to home screen** on your phone for an app-like icon and offline use.

## Use
Open the deployed URL on your phone → **+ Scan / Add** → Open camera → Capture → fill name/game/tags → Save.
Search and filter from the top bar. **Export JSON** makes a backup; **Import JSON** restores or moves data to another device.

## Online sync (optional — shares one database across devices)
Without setup the app is local-only per device. To share one database:

1. Create a free project at **supabase.com**.
2. **SQL Editor → New query** → paste the contents of `supabase-setup.sql` → **Run**.
3. **Project Settings → API** → copy the **Project URL** and the **anon public** key.
4. In the app: **Sync** → paste both → **Test & sync now** → **Save**.
5. Do the same paste on the other phone. Both now read/write the same data.

It stays offline-capable: the local IndexedDB is a cache, and changes sync to Supabase when online.

Security note: the included policy lets the anon key read/write the `cards` table — fine for a
private family list. To lock it down, swap in authenticated-only policies + Supabase Auth.

## Deploy
Static site, zero build. On Vercel: **Add New → Project → import this repo → Deploy** (Framework preset: *Other*).

## Files
- `index.html` / `styles.css` / `app.js` — the app
- `manifest.webmanifest` / `sw.js` / `icons/` — PWA install + offline
- `vercel.json` — static hosting config
- `Card-Game-Tracker.xlsx` — original spreadsheet catalogue (kept for reference)
