// JoshCards — local-first card catalogue (IndexedDB + camera capture)
'use strict';

const GAMES = [
  'Pokémon', 'Magic: The Gathering', 'Glade (Gilbert Walker)',
  'Star Realms', 'Soul Talk', 'Family Roast', 'We Do (toddler)',
  'The Mind', 'Monopoly Deal', 'Playing cards', 'Other'
];

// Controlled tag vocabulary — keeps colour/look/shape search clean.
const TAGS = [
  'red','blue','green','black','white','yellow','colourless','multicolour',
  'foil','holo','full-art','proxy','round-corners','square-corners',
  'oversized','token','basic','rare','common'
];

// ---------- IndexedDB ----------
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('joshcards', 1);
    r.onupgradeneeded = () => {
      const s = r.result.createObjectStore('cards', { keyPath: 'id' });
      s.createIndex('game', 'game', { unique: false });
    };
    r.onsuccess = () => { db = r.result; res(); };
    r.onerror = () => rej(r.error);
  });
}
function tx(mode) { return db.transaction('cards', mode).objectStore('cards'); }
function putCard(c) { return new Promise((res, rej) => { const r = tx('readwrite').put(c); r.onsuccess = res; r.onerror = () => rej(r.error); }); }
function delCard(id) { return new Promise((res, rej) => { const r = tx('readwrite').delete(id); r.onsuccess = res; r.onerror = () => rej(r.error); }); }
function allCards() { return new Promise((res, rej) => { const r = tx('readonly').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }

// ---------- Online sync (Supabase REST) ----------
function syncCfg() {
  // In-app Sync dialog overrides; otherwise fall back to the built-in default (config.js).
  try {
    const c = JSON.parse(localStorage.getItem('joshcards_sync') || 'null');
    if (c && c.url && c.key) return c;
  } catch { /* ignore */ }
  const d = window.JOSHCARDS_SYNC;
  return (d && d.url && d.key) ? d : null;
}
function saveSyncCfg(url, key) {
  if (url && key) localStorage.setItem('joshcards_sync', JSON.stringify({ url: url.replace(/\/+$/, ''), key }));
  else localStorage.removeItem('joshcards_sync');
}
function sbHeaders(cfg) {
  return { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key, 'Content-Type': 'application/json' };
}
async function remoteGetAll(cfg) {
  const r = await fetch(cfg.url + '/rest/v1/cards?select=*', { headers: sbHeaders(cfg) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
async function remoteUpsert(cfg, card) {
  const r = await fetch(cfg.url + '/rest/v1/cards', {
    method: 'POST',
    headers: { ...sbHeaders(cfg), Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(card)
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
}
async function remoteDelete(cfg, id) {
  const r = await fetch(cfg.url + '/rest/v1/cards?id=eq.' + encodeURIComponent(id), {
    method: 'DELETE', headers: sbHeaders(cfg)
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
}

// Data layer: local IndexedDB is always the cache; remote is the shared truth.
// If a remote write fails (offline), queue it and retry on next load / reconnect.
async function dataPut(card) {
  await putCard(card);
  const cfg = syncCfg();
  if (!cfg) return;
  try { await remoteUpsert(cfg, card); }
  catch { enqueue({ op: 'upsert', id: card.id, card }); }
}
async function dataDelete(id) {
  await delCard(id);
  addTombstone(id);
  const cfg = syncCfg();
  if (!cfg) return;
  try { await remoteDelete(cfg, id); }
  catch { enqueue({ op: 'delete', id }); }
}

// --- Pending-op queue (survives reloads via localStorage) ---
function pendingOps() {
  try { return JSON.parse(localStorage.getItem('joshcards_pending') || '[]'); } catch { return []; }
}
function setPending(q) { localStorage.setItem('joshcards_pending', JSON.stringify(q)); }
function enqueue(op) {
  const q = pendingOps().filter(o => o.id !== op.id); // latest op per card wins
  q.push(op);
  setPending(q);
}
async function flushQueue(cfg) {
  let q = pendingOps();
  if (!q.length) return;
  const remaining = [];
  for (const op of q) {
    try {
      if (op.op === 'delete') await remoteDelete(cfg, op.id);
      else await remoteUpsert(cfg, op.card);
    } catch { remaining.push(op); } // still offline — keep for next time
  }
  setPending(remaining);
}

// Track deletions so a stale local copy on another device doesn't resurrect them.
function tombstones() {
  try { return JSON.parse(localStorage.getItem('joshcards_deleted') || '[]'); } catch { return []; }
}
function addTombstone(id) {
  const t = tombstones();
  if (!t.includes(id)) { t.push(id); localStorage.setItem('joshcards_deleted', JSON.stringify(t)); }
}

// ---------- State / elements ----------
let cards = [];
let editingId = null;
let stream = null;
const $ = (id) => document.getElementById(id);

// ---------- Rendering ----------
function fillSelect(sel, items, includeAll, allLabel) {
  sel.innerHTML = '';
  if (includeAll) sel.append(new Option(allLabel, ''));
  items.forEach(i => sel.append(new Option(i, i)));
}

function render() {
  const q = $('search').value.trim().toLowerCase();
  const fg = $('filterGame').value;
  const ft = $('filterTag').value;
  const list = cards.filter(c => {
    if (fg && c.game !== fg) return false;
    if (ft && !(c.tags || []).includes(ft)) return false;
    if (!q) return true;
    const hay = [c.name, c.type, c.cost, c.power, c.rarity, c.location, (c.tags || []).join(' ')]
      .join(' ').toLowerCase();
    return hay.includes(q);
  });
  $('count').textContent = `${list.length} / ${cards.length} cards`;
  const grid = $('grid');
  grid.innerHTML = '';
  list.forEach(c => {
    const el = document.createElement('div');
    el.className = 'card';
    el.onclick = () => openDialog(c);
    const img = c.image ? `<img src="${c.image}" alt="">` : `<img alt="" src="icons/icon.svg">`;
    el.innerHTML = `${img}<div class="body">
      <div class="name">${esc(c.name)}${c.qty > 1 ? ` ×${c.qty}` : ''}</div>
      <div class="meta">${esc(c.game || '')}${c.location ? ' · ' + esc(c.location) : ''}</div>
    </div>`;
    grid.append(el);
  });
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m])); }

// ---------- Dialog ----------
function openDialog(card) {
  editingId = card ? card.id : null;
  $('dialogTitle').textContent = card ? 'Edit card' : 'Add card';
  $('f_name').value = card?.name || '';
  $('f_game').value = card?.game || GAMES[0];
  $('f_type').value = card?.type || '';
  $('f_cost').value = card?.cost || '';
  $('f_power').value = card?.power || '';
  $('f_rarity').value = card?.rarity || '';
  $('f_qty').value = card?.qty || 1;
  $('f_loc').value = card?.location || '';
  $('f_tags').value = (card?.tags || []).join(', ');
  currentImage = card?.image || null;
  showPreview(currentImage);
  renderChips(card?.tags || []);
  setStatus('');
  $('deleteBtn').hidden = !card;
  $('cardDialog').showModal();
}

let currentImage = null;
function renderChips(active) {
  const wrap = $('tagChips');
  wrap.innerHTML = '';
  TAGS.forEach(t => {
    const c = document.createElement('span');
    c.className = 'chip' + (active.includes(t) ? ' on' : '');
    c.textContent = t;
    c.onclick = () => {
      const cur = parseTags($('f_tags').value);
      const i = cur.indexOf(t);
      if (i >= 0) cur.splice(i, 1); else cur.push(t);
      $('f_tags').value = cur.join(', ');
      c.classList.toggle('on');
    };
    wrap.append(c);
  });
}
function parseTags(s) { return s.split(',').map(x => x.trim()).filter(Boolean); }

function showPreview(src) {
  const p = $('preview');
  if (src) { p.src = src; p.hidden = false; } else { p.hidden = true; p.removeAttribute('src'); }
  $('video').hidden = true;
  $('shotBtn').hidden = true;
}

// ---------- Camera ----------
async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const v = $('video');
    v.srcObject = stream; v.hidden = false;
    $('preview').hidden = true;
    $('shotBtn').hidden = false;
  } catch (e) {
    alert('Camera unavailable (' + e.name + '). Use “Photo / file” instead.');
  }
}
function stopCamera() {
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
}
function capture() {
  const v = $('video'), cv = $('canvas');
  const w = v.videoWidth, h = v.videoHeight;
  // downscale longest side to ~1000px to keep storage small
  const scale = Math.min(1, 1000 / Math.max(w, h));
  cv.width = w * scale; cv.height = h * scale;
  cv.getContext('2d').drawImage(v, 0, 0, cv.width, cv.height);
  currentImage = cv.toDataURL('image/jpeg', 0.8);
  stopCamera();
  showPreview(currentImage);
  autoScan();
}
function fileToImage(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const cv = $('canvas');
      const scale = Math.min(1, 1000 / Math.max(img.width, img.height));
      cv.width = img.width * scale; cv.height = img.height * scale;
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      currentImage = cv.toDataURL('image/jpeg', 0.8);
      showPreview(currentImage);
      autoScan();
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

// ---------- OCR + database lookup (autofill) ----------
function setStatus(msg, isErr, loading) {
  const s = $('scanStatus');
  if (!msg) { s.hidden = true; s.innerHTML = ''; return; }
  s.hidden = false;
  s.innerHTML = (loading ? '<span class="spinner"></span>' : '') + '<span></span>';
  s.lastChild.textContent = msg;
  s.classList.toggle('err', !!isErr);
}

// Read the card name off the photo, then enrich from the right card database.
async function autoScan() {
  if (!currentImage) return;
  let name = '';
  if (window.Tesseract) {
    try {
      setStatus('Reading card…', false, true);
      const { data } = await Tesseract.recognize(currentImage, 'eng', {
        logger: m => {
          if (m.status === 'recognizing text') {
            setStatus('Reading card… ' + Math.round(m.progress * 100) + '%', false, true);
          }
        }
      });
      name = bestNameLine(data.text);
      if (name) $('f_name').value = name;
    } catch (e) {
      setStatus('Could not read text — type the name and tap Look up.', true);
    }
  }
  // Use OCR result (or whatever's already typed) to enrich from the DB.
  await lookup();
}

// Pick the most name-like line: top-most line with a few letters, skip noise.
function bestNameLine(text) {
  const lines = (text || '').split('\n')
    .map(l => l.replace(/[^A-Za-z0-9 ',.-]/g, '').trim())
    .filter(l => l.replace(/[^A-Za-z]/g, '').length >= 3);
  return lines[0] || '';
}

// Enrich fields from the free database matching the chosen game.
async function lookup() {
  const game = $('f_game').value;
  const name = $('f_name').value.trim();
  if (!name) { setStatus('Type a name first, then Look up.', true); return; }
  const btn = $('lookupBtn');
  btn.disabled = true;
  try {
    let hit = null;
    if (/magic/i.test(game)) { setStatus('Searching Scryfall…', false, true); hit = await lookupMTG(name); }
    else if (/pok/i.test(game)) { setStatus('Searching Pokémon TCG…', false, true); hit = await lookupPokemon(name); }
    else { setStatus('No card database for this game — keeping your photo & name.'); return; }

    if (!hit) { setStatus('No match found — check the name and Look up again.', true); return; }
    applyHit(hit);
    setStatus('Filled from ' + hit.source + ' ✓');
  } catch (e) {
    setStatus('Lookup failed (offline?). Fields stay editable.', true);
  } finally {
    btn.disabled = false;
  }
}

function applyHit(h) {
  $('f_name').value = h.name || $('f_name').value;
  if (h.type) $('f_type').value = h.type;
  if (h.cost) $('f_cost').value = h.cost;
  if (h.power) $('f_power').value = h.power;
  if (h.rarity) $('f_rarity').value = h.rarity;
  if (h.image) { currentImage = h.image; showPreview(currentImage); }
}

// --- Mappers: raw API card -> our hit shape (image = official art) ---
function mapMTG(c) {
  const colours = (c.colors && c.colors.length) ? c.colors.join('') : 'Colourless';
  const uris = c.image_uris || c.card_faces?.[0]?.image_uris || {};
  return {
    source: 'Scryfall',
    name: c.name,
    type: c.type_line || colours,
    cost: c.mana_cost || '',
    power: (c.power && c.toughness) ? `${c.power}/${c.toughness}` : '',
    rarity: c.rarity || '',
    image: uris.normal || null,
    thumb: uris.small || uris.normal || null,
    sub: [c.set_name, c.rarity].filter(Boolean).join(' · ')
  };
}
function mapPokemon(c) {
  const cost = c.attacks && c.attacks[0] && c.attacks[0].cost ? c.attacks[0].cost.join(' ') : '';
  return {
    source: 'Pokémon TCG',
    name: c.name,
    type: (c.types || []).join(', '),
    cost,
    power: c.hp ? 'HP ' + c.hp : '',
    rarity: c.rarity || '',
    image: c.images ? c.images.large : null,
    thumb: c.images ? c.images.small : null,
    sub: [c.set?.name, c.rarity].filter(Boolean).join(' · ')
  };
}

// Scryfall — Magic: The Gathering (free, no key, fuzzy name match)
async function lookupMTG(name) {
  const r = await fetch('https://api.scryfall.com/cards/named?fuzzy=' + encodeURIComponent(name));
  if (!r.ok) return null;
  const c = await r.json();
  if (c.object === 'error') return null;
  return mapMTG(c);
}
async function searchMTG(name) {
  const r = await fetch('https://api.scryfall.com/cards/search?order=name&q=' +
    encodeURIComponent(name));
  if (!r.ok) return [];
  const j = await r.json();
  return (j.data || []).slice(0, 30).map(mapMTG);
}

// Pokémon TCG API (free, no key needed for light use)
async function lookupPokemon(name) {
  const url = 'https://api.pokemontcg.io/v2/cards?pageSize=1&q=' +
    encodeURIComponent('name:"' + name + '"');
  const r = await fetch(url);
  if (!r.ok) return null;
  const j = await r.json();
  const c = j.data && j.data[0];
  return c ? mapPokemon(c) : null;
}
async function searchPokemon(name) {
  const url = 'https://api.pokemontcg.io/v2/cards?pageSize=30&orderBy=name&q=' +
    encodeURIComponent('name:"' + name + '*"');
  const r = await fetch(url);
  if (!r.ok) return [];
  const j = await r.json();
  return (j.data || []).map(mapPokemon);
}

// --- Find-by-name dialog ---
async function runFind() {
  const game = $('find_game').value;
  const name = $('find_name').value.trim();
  const results = $('findResults');
  results.innerHTML = '';
  if (!name) { setFindStatus('Type a name to search.', true); return; }
  if (!/magic/i.test(game) && !/pok/i.test(game)) {
    setFindStatus('Find-by-name only works for Magic & Pokémon (no database for others).', true);
    return;
  }
  const goBtn = $('findGoBtn');
  goBtn.disabled = true;
  setFindStatus('Searching ' + game + '…', false, true);
  try {
    const hits = /magic/i.test(game) ? await searchMTG(name) : await searchPokemon(name);
    if (!hits.length) { setFindStatus('No matches.', true); return; }
    setFindStatus(hits.length + ' result' + (hits.length > 1 ? 's' : '') + ' — tap to add.');
    hits.forEach(h => {
      const row = document.createElement('div');
      row.className = 'result';
      row.innerHTML = `<img src="${h.thumb || 'icons/icon.svg'}" alt="">
        <div><div class="rn">${esc(h.name)}</div><div class="rs">${esc(h.sub || '')}</div></div>`;
      row.onclick = () => {
        $('findDialog').close();
        openDialog(null);
        $('f_game').value = game;
        applyHit(h);
        setStatus('Filled from ' + h.source + ' ✓');
      };
      results.append(row);
    });
  } catch (e) {
    setFindStatus('Search failed (offline?).', true);
  } finally {
    $('findGoBtn').disabled = false;
  }
}
function setFindStatus(msg, isErr, loading) {
  const s = $('findStatus');
  if (!msg) { s.hidden = true; s.innerHTML = ''; return; }
  s.hidden = false;
  s.innerHTML = (loading ? '<span class="spinner"></span>' : '') + '<span></span>';
  s.lastChild.textContent = msg;
  s.classList.toggle('err', !!isErr);
}

// ---------- Save / delete ----------
async function save() {
  const name = $('f_name').value.trim();
  if (!name) { $('f_name').focus(); return; }
  const card = {
    id: editingId || (Date.now().toString(36) + Math.random().toString(36).slice(2, 7)),
    name,
    game: $('f_game').value,
    type: $('f_type').value.trim(),
    cost: $('f_cost').value.trim(),
    power: $('f_power').value.trim(),
    rarity: $('f_rarity').value.trim(),
    qty: parseInt($('f_qty').value, 10) || 1,
    location: $('f_loc').value.trim(),
    tags: parseTags($('f_tags').value),
    image: currentImage || null,
    updated: new Date().toISOString()
  };
  try {
    await dataPut(card);
  } catch (e) {
    alert('Saved locally, but online sync failed: ' + e.message + '\nIt will need re-saving when sync works.');
  }
  await reload();
  $('cardDialog').close();
}
async function removeCard() {
  if (editingId && confirm('Delete this card?')) {
    try { await dataDelete(editingId); }
    catch (e) { alert('Deleted locally, but online sync failed: ' + e.message); }
    await reload();
    $('cardDialog').close();
  }
}

async function reload() {
  const cfg = syncCfg();
  if (cfg) {
    try {
      await flushQueue(cfg); // push any offline edits/deletes first
      const remote = await remoteGetAll(cfg);
      const remoteIds = new Set(remote.map(c => c.id));
      const dead = new Set(tombstones());
      // pull: mirror remote into local cache so offline still shows everything
      for (const c of remote) if (!dead.has(c.id)) await putCard(c);
      // push: upload local-only cards that were never synced (and weren't deleted)
      for (const c of await allCards()) {
        if (!remoteIds.has(c.id) && !dead.has(c.id)) await remoteUpsert(cfg, c);
      }
      // drop locally-cached copies of cards deleted elsewhere
      for (const id of dead) if (!remoteIds.has(id)) await delCard(id);
    } catch (e) {
      console.warn('Sync failed, showing local cache:', e.message);
    }
  }
  cards = (await allCards()).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  render();
  $('syncBtn').textContent = cfg ? 'Sync ✓' : 'Sync';
}

// ---------- Import / export ----------
function exportJSON() {
  const blob = new Blob([JSON.stringify(cards, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'joshcards-backup.json';
  a.click();
}
async function importJSON(file) {
  const text = await file.text();
  const arr = JSON.parse(text);
  for (const c of arr) { if (c && c.id) await dataPut(c); }
  await reload();
  alert('Imported ' + arr.length + ' cards.');
}

// ---------- Sync dialog ----------
function setSyncStatus(msg, isErr) {
  const s = $('syncStatus');
  if (!msg) { s.hidden = true; return; }
  s.hidden = false; s.textContent = msg; s.classList.toggle('err', !!isErr);
}
function openSync() {
  const cfg = syncCfg();
  $('s_url').value = cfg?.url || '';
  $('s_key').value = cfg?.key || '';
  setSyncStatus(cfg ? 'Sync is on.' : '');
  $('syncDialog').showModal();
}
async function testSync() {
  const url = $('s_url').value.trim().replace(/\/+$/, ''), key = $('s_key').value.trim();
  if (!url || !key) { setSyncStatus('Enter both URL and key.', true); return; }
  setSyncStatus('Testing…');
  try {
    const rows = await remoteGetAll({ url, key });
    saveSyncCfg(url, key);
    // push anything local that isn't on the server yet
    for (const c of await allCards()) await remoteUpsert({ url, key }, c);
    await reload();
    setSyncStatus(`Connected ✓ — ${rows.length} cards on server, local cards uploaded.`);
  } catch (e) {
    setSyncStatus('Failed: ' + e.message + ' — check URL, key, and that the cards table exists.', true);
  }
}

// ---------- Duplicates ----------
function setDupStatus(msg, isErr) {
  const s = $('dupStatus');
  if (!msg) { s.hidden = true; return; }
  s.hidden = false; s.textContent = msg; s.classList.toggle('err', !!isErr);
}
function dupKey(c, mode) {
  const n = (c.name || '').trim().toLowerCase();
  return mode === 'n' ? n : n + '|' + (c.game || '');
}
function renderDuplicates() {
  const mode = $('dupMatch').value;
  const groups = {};
  cards.forEach(c => { (groups[dupKey(c, mode)] ||= []).push(c); });
  const dups = Object.values(groups).filter(g => g.length > 1);
  const box = $('dupResults');
  box.innerHTML = '';
  if (!dups.length) { setDupStatus('No duplicates found. 🎉'); return; }
  const total = dups.reduce((n, g) => n + g.length - 1, 0);
  setDupStatus(`${dups.length} group${dups.length > 1 ? 's' : ''} with ${total} extra cop${total > 1 ? 'ies' : 'y'}.`);
  dups.forEach(group => {
    const div = document.createElement('div');
    div.className = 'dupGroup';
    const head = document.createElement('div');
    head.className = 'dupHead';
    head.innerHTML = `<span class="gt">${esc(group[0].name)} <span class="rs">${esc(group[0].game || '')}</span> ×${group.length}</span>`;
    const mergeBtn = document.createElement('button');
    mergeBtn.className = 'primary';
    mergeBtn.textContent = 'Merge into 1';
    mergeBtn.onclick = () => mergeGroup(group);
    head.append(mergeBtn);
    div.append(head);
    group.forEach(c => {
      const row = document.createElement('div');
      row.className = 'dupRow';
      row.innerHTML = `<img src="${c.image || 'icons/icon.svg'}" alt="">
        <span class="dm">qty ${c.qty || 1}${c.location ? ' · ' + esc(c.location) : ''}</span>`;
      const del = document.createElement('button');
      del.className = 'danger';
      del.textContent = 'Delete';
      del.onclick = async () => { await dataDelete(c.id); await reload(); renderDuplicates(); };
      row.append(del);
      div.append(row);
    });
    box.append(div);
  });
}
// Keep the first card, add up all quantities, delete the rest.
async function mergeGroup(group) {
  const keep = { ...group[0] };
  keep.qty = group.reduce((n, c) => n + (parseInt(c.qty, 10) || 1), 0);
  keep.updated = new Date().toISOString();
  await dataPut(keep);
  for (const c of group.slice(1)) await dataDelete(c.id);
  await reload();
  renderDuplicates();
}

// ---------- Wire up ----------
async function init() {
  fillSelect($('f_game'), GAMES, false);
  fillSelect($('filterGame'), GAMES, true, 'All games');
  fillSelect($('filterTag'), TAGS, true, 'All tags');
  fillSelect($('find_game'), GAMES.filter(g => /magic|pok/i.test(g)), false);
  await openDB();
  await reload();

  $('addBtn').onclick = () => openDialog(null);
  $('findBtn').onclick = () => { setFindStatus(''); $('findResults').innerHTML = ''; $('findDialog').showModal(); };
  $('findGoBtn').onclick = runFind;
  $('find_name').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); runFind(); } });
  $('findCloseBtn').onclick = () => $('findDialog').close();
  $('search').oninput = render;
  $('filterGame').onchange = render;
  $('filterTag').onchange = render;
  $('camBtn').onclick = startCamera;
  $('shotBtn').onclick = capture;
  $('fileInput').onchange = (e) => e.target.files[0] && fileToImage(e.target.files[0]);
  $('lookupBtn').onclick = lookup;
  $('saveBtn').onclick = save;
  $('deleteBtn').onclick = removeCard;
  $('cancelBtn').onclick = () => { stopCamera(); $('cardDialog').close(); };
  $('cardDialog').addEventListener('close', stopCamera);
  $('dupBtn').onclick = () => { renderDuplicates(); $('dupDialog').showModal(); };
  $('dupMatch').onchange = renderDuplicates;
  $('dupCloseBtn').onclick = () => $('dupDialog').close();
  $('syncBtn').onclick = openSync;
  $('syncSaveBtn').onclick = () => { saveSyncCfg($('s_url').value.trim(), $('s_key').value.trim()); reload(); $('syncDialog').close(); };
  $('syncCloseBtn').onclick = () => $('syncDialog').close();
  $('syncTestBtn').onclick = testSync;
  $('exportBtn').onclick = exportJSON;
  $('importInput').onchange = (e) => e.target.files[0] && importJSON(e.target.files[0]);

  // When the connection comes back, flush queued changes and refresh.
  window.addEventListener('online', () => reload());

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
init();
