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

## Known limitation (by design, for now)
Each device keeps its own copy — Josh's phone and Sylvie's phone don't auto-sync.
Use Export/Import to move a snapshot between them. Upgrade path: swap IndexedDB for a hosted
DB (e.g. Vercel Postgres / Supabase) + a small API route for real-time multi-device sync.

## Deploy
Static site, zero build. On Vercel: **Add New → Project → import this repo → Deploy** (Framework preset: *Other*).

## Files
- `index.html` / `styles.css` / `app.js` — the app
- `manifest.webmanifest` / `sw.js` / `icons/` — PWA install + offline
- `vercel.json` — static hosting config
- `Card-Game-Tracker.xlsx` — original spreadsheet catalogue (kept for reference)
