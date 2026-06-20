// JoshCards — local-first card catalogue (IndexedDB + camera capture)
'use strict';

const CATALOG = window.JOSHCARDS_CATALOG || {};
const GAMES = CATALOG.games || ['Pokemon', 'Magic: The Gathering', 'Other'];
const TAGS = CATALOG.tags || ['foil', 'holo', 'rare', 'common'];

// ---------- IndexedDB ----------
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('joshcards', 2);
    r.onupgradeneeded = (e) => {
      const d = r.result;
      if (!d.objectStoreNames.contains('cards')) {
        d.createObjectStore('cards', { keyPath: 'id' }).createIndex('game', 'game', { unique: false });
      }
      if (!d.objectStoreNames.contains('decks')) {
        d.createObjectStore('decks', { keyPath: 'id' });
      }
    };
    r.onsuccess = () => { db = r.result; res(); };
    r.onerror = () => rej(r.error);
  });
}
function tx(mode) { return db.transaction('cards', mode).objectStore('cards'); }
function putCard(c) { return new Promise((res, rej) => { const r = tx('readwrite').put(c); r.onsuccess = res; r.onerror = () => rej(r.error); }); }
function delCard(id) { return new Promise((res, rej) => { const r = tx('readwrite').delete(id); r.onsuccess = res; r.onerror = () => rej(r.error); }); }
function allCards() { return new Promise((res, rej) => { const r = tx('readonly').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
function dtx(mode) { return db.transaction('decks', mode).objectStore('decks'); }
function putDeckLocal(d) { return new Promise((res, rej) => { const r = dtx('readwrite').put(d); r.onsuccess = res; r.onerror = () => rej(r.error); }); }
function delDeckLocal(id) { return new Promise((res, rej) => { const r = dtx('readwrite').delete(id); r.onsuccess = res; r.onerror = () => rej(r.error); }); }
function allDecksLocal() { return new Promise((res, rej) => { const r = dtx('readonly').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }

// ---------- Online sync (Supabase REST) ----------
function syncCfg() {
  // In-app Sync dialog overrides; otherwise fall back to an optional project default.
  try {
    const c = JSON.parse(localStorage.getItem('joshcards_sync') || 'null');
    if (c && c.url && c.key) return { ...c, collection: c.collection || 'default' };
  } catch { /* ignore */ }
  const d = window.JOSHCARDS_SYNC;
  return (d && d.url && d.key) ? { ...d, collection: d.collection || 'default' } : null;
}
function cleanCollectionId(id) {
  return (id || '').trim().replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48) || makeCollectionId();
}
function makeCollectionId() {
  return 'cards-' + Math.random().toString(36).slice(2, 10);
}
function saveSyncCfg(url, key, collection) {
  if (url && key) {
    localStorage.setItem('joshcards_sync', JSON.stringify({
      url: url.replace(/\/+$/, ''),
      key,
      collection: cleanCollectionId(collection)
    }));
  }
  else localStorage.removeItem('joshcards_sync');
}
function sbHeaders(cfg) {
  return { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key, 'Content-Type': 'application/json' };
}
function withCollection(cfg, row) {
  return { ...row, collection_id: cleanCollectionId(cfg.collection) };
}
async function remoteGetAll(cfg) {
  const r = await fetch(cfg.url + '/rest/v1/cards?select=*&collection_id=eq.' + encodeURIComponent(cleanCollectionId(cfg.collection)), { headers: sbHeaders(cfg) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
async function remoteUpsert(cfg, card) {
  const r = await fetch(cfg.url + '/rest/v1/cards?on_conflict=collection_id,id', {
    method: 'POST',
    headers: { ...sbHeaders(cfg), Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(withCollection(cfg, card))
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
}
async function remoteDelete(cfg, id) {
  const r = await fetch(cfg.url + '/rest/v1/cards?collection_id=eq.' + encodeURIComponent(cleanCollectionId(cfg.collection)) + '&id=eq.' + encodeURIComponent(id), {
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

// Resolve a card's deck category/flags — uses stored meta, else infers from fields
// so cards added before deck-building still categorise reasonably.
function cardMeta(c) {
  if (c.meta && c.meta.cat) return c.meta;
  const game = c.game || '';
  if (/magic/i.test(game)) {
    const t = (c.type || '').toLowerCase();
    const land = t.includes('land');
    return { cat: land ? 'land' : 'spell', noLimit: land && t.includes('basic'), basicPokemon: false, aceSpec: false };
  }
  // Pokémon heuristics
  if (/^hp/i.test(c.power || '')) return { cat: 'pokemon', noLimit: false, basicPokemon: true, aceSpec: false };
  if (/energy/i.test(c.name || '')) {
    const basic = /^(grass|fire|water|lightning|psychic|fighting|darkness|metal|fairy|dragon|colorless)?\s*energy$/i.test((c.name || '').trim());
    return { cat: 'energy', noLimit: basic, basicPokemon: false, aceSpec: false };
  }
  return { cat: 'trainer', noLimit: false, basicPokemon: false, aceSpec: false };
}

// ---------- Deck storage (local + Supabase 'decks' table) ----------
async function remoteGetDecks(cfg) {
  const r = await fetch(cfg.url + '/rest/v1/decks?select=*&collection_id=eq.' + encodeURIComponent(cleanCollectionId(cfg.collection)), { headers: sbHeaders(cfg) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
async function remoteUpsertDeck(cfg, deck) {
  const r = await fetch(cfg.url + '/rest/v1/decks?on_conflict=collection_id,id', {
    method: 'POST', headers: { ...sbHeaders(cfg), Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(withCollection(cfg, deck))
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
}
async function remoteDeleteDeck(cfg, id) {
  const r = await fetch(cfg.url + '/rest/v1/decks?collection_id=eq.' + encodeURIComponent(cleanCollectionId(cfg.collection)) + '&id=eq.' + encodeURIComponent(id), {
    method: 'DELETE', headers: sbHeaders(cfg)
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
}
async function dataPutDeck(d) {
  await putDeckLocal(d);
  const cfg = syncCfg();
  if (cfg) { try { await remoteUpsertDeck(cfg, d); } catch (e) { console.warn('deck sync', e.message); } }
}
async function dataDeleteDeck(id) {
  await delDeckLocal(id);
  const cfg = syncCfg();
  if (cfg) { try { await remoteDeleteDeck(cfg, id); } catch (e) { console.warn('deck sync', e.message); } }
}
async function loadDecks() {
  const cfg = syncCfg();
  if (cfg) {
    try {
      const remote = await remoteGetDecks(cfg);
      const ids = new Set(remote.map(d => d.id));
      for (const d of remote) await putDeckLocal(d);
      for (const d of await allDecksLocal()) if (!ids.has(d.id)) await remoteUpsertDeck(cfg, d);
    } catch (e) { console.warn('deck load', e.message); }
  }
  decks = (await allDecksLocal()).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

// ---------- State / elements ----------
let cards = [];
let decks = [];
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
  const fo = $('filterOwn') ? $('filterOwn').value : '';
  const list = cards.filter(c => {
    if (fg && c.game !== fg) return false;
    if (ft && !(c.tags || []).includes(ft)) return false;
    if (fo === 'owned' && c.meta?.wishlist) return false;
    if (fo === 'wish' && !c.meta?.wishlist) return false;
    if (!q) return true;
    const hay = [c.name, c.type, c.cost, c.power, c.rarity, c.location, (c.tags || []).join(' '),
      c.meta?.setCode, c.meta?.number, c.meta?.condition].join(' ').toLowerCase();
    return hay.includes(q);
  });
  const sort = $('sortBy') ? $('sortBy').value : 'name';
  const byName = (a, b) => (a.name || '').localeCompare(b.name || '');
  list.sort((a, b) => {
    switch (sort) {
      case 'price': return ((b.price || 0) * (b.qty || 1)) - ((a.price || 0) * (a.qty || 1)) || byName(a, b);
      case 'qty': return (b.qty || 1) - (a.qty || 1) || byName(a, b);
      case 'recent': return (b.updated || '').localeCompare(a.updated || '') || byName(a, b);
      case 'game': return (a.game || '').localeCompare(b.game || '') || byName(a, b);
      default: return byName(a, b);
    }
  });
  $('count').textContent = `${list.length} / ${cards.length} cards`;
  const grid = $('grid');
  grid.innerHTML = '';
  $('emptyState').hidden = cards.length > 0 || q || fg || ft;
  let lastGame = null;
  list.forEach(c => {
    if (sort === 'game' && c.game !== lastGame) {
      lastGame = c.game;
      const h = document.createElement('div');
      h.className = 'gridHeader';
      const n = list.filter(x => x.game === c.game).length;
      h.textContent = `${c.game || 'Other'} (${n})`;
      grid.append(h);
    }
    const el = document.createElement('div');
    el.className = 'card';
    el.onclick = () => openDetail(c);
    const img = c.image ? `<img src="${c.image}" alt="">` : `<img alt="" src="icons/icon.svg">`;
    el.innerHTML = `${img}<div class="body">
      <div class="name">${c.meta?.wishlist ? '★ ' : ''}${esc(c.name)}</div>
      <div class="meta">${esc(c.game || '')}${c.location ? ' · ' + esc(c.location) : ''}${c.meta?.condition ? ' · ' + esc(c.meta.condition) : ''}</div>
      ${c.price != null ? `<div class="price">$${money(c.price * (c.qty || 1))}${c.qty > 1 ? ` ($${money(c.price)} ea)` : ''}</div>` : ''}
    </div>`;
    const step = document.createElement('div');
    step.className = 'cardStep';
    const mk = (txt, d) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = txt;
      b.onclick = (e) => { e.stopPropagation(); adjustQty(c, d); }; return b; };
    const ct = document.createElement('span'); ct.className = 'cct'; ct.textContent = '×' + (c.qty || 1);
    step.append(mk('−', -1), ct, mk('+', +1));
    el.querySelector('.body').append(step);
    grid.append(el);
  });
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m])); }

// "What should we play?" — pick a random game you actually own cards for.
function randomGame() {
  const owned = [...new Set(cards.filter(c => !c.meta?.wishlist).map(c => c.game).filter(Boolean))];
  const pool = owned.length ? owned : (window.JOSHCARDS_CATALOG?.games || []);
  if (!pool.length) { alert('Add some cards first!'); return; }
  const pick = pool[Math.floor(Math.random() * pool.length)];
  alert('🎲 Tonight, play:\n\n' + pick);
}

function applyTheme(t) {
  if (t === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
  localStorage.setItem('joshcards_theme', t);
  const btn = $('themeBtn'); if (btn) btn.textContent = t === 'light' ? '☀️' : '🌙';
}

// Card detail view (tap a card). Edit button drops into the editor.
let detailCard = null;
function openDetail(c) {
  detailCard = c;
  $('detailImg').src = c.image || 'icons/icon.svg';
  $('detailName').textContent = c.name || '';
  const rows = [
    ['Game', c.game], ['Type / Colour', c.type], ['Cost', c.cost], ['Power / HP', c.power],
    ['Rarity', c.rarity], ['Condition', c.meta?.condition], ['Quantity', c.qty || 1],
    ['Location', c.location], ['Tags', (c.tags || []).join(', ')]
  ].filter(r => r[1] !== '' && r[1] != null);
  let html = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  if (c.price != null) html += `<dt>Value</dt><dd class="price">$${money(c.price * (c.qty || 1))}${c.qty > 1 ? ` ($${money(c.price)} ea)` : ''}</dd>`;
  $('detailFields').innerHTML = html;
  $('detailDialog').showModal();
}

// Quick quantity change from the grid (no dialog).
async function adjustQty(card, delta) {
  const qty = Math.max(1, (card.qty || 1) + delta);
  const updated = { ...card, qty, updated: new Date().toISOString() };
  try { await dataPut(updated); } catch { /* synced on next load */ }
  await reload();
}

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
  $('f_price').value = card?.price != null ? card.price : '';
  $('f_qty').value = card?.qty || 1;
  $('f_condition').value = card?.meta?.condition || '';
  $('f_wishlist').checked = !!card?.meta?.wishlist;
  $('f_loc').value = card?.location || '';
  $('f_tags').value = (card?.tags || []).join(', ');
  currentImage = card?.image || null;
  currentMeta = card?.meta ? { ...card.meta } : {};
  showPreview(currentImage);
  renderChips(card?.tags || []);
  setStatus('');
  $('deleteBtn').hidden = !card;
  $('cardDialog').showModal();
}

let currentImage = null;
let currentMeta = {};
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
  maybeAutoScan();
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
      maybeAutoScan();
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

// ---------- OCR + database lookup (autofill) ----------
function ocrEnabled() {
  return localStorage.getItem('joshcards_ocr') === '1';
}
function setOcrEnabled(enabled) {
  localStorage.setItem('joshcards_ocr', enabled ? '1' : '0');
}
function maybeAutoScan() {
  if (ocrEnabled()) autoScan();
  else setStatus('Photo added. Type the card name or use Find by name for better matches.');
}
function setStatus(msg, isErr, loading, onCancel) {
  renderStatus($('scanStatus'), msg, isErr, loading, onCancel);
}
// Shared status renderer: spinner + message + optional Cancel button.
function renderStatus(s, msg, isErr, loading, onCancel) {
  if (!msg) { s.hidden = true; s.innerHTML = ''; return; }
  s.hidden = false;
  s.innerHTML = (loading ? '<span class="spinner"></span>' : '') + '<span class="stxt"></span>';
  s.querySelector('.stxt').textContent = msg;
  s.classList.toggle('err', !!isErr);
  if (onCancel) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'cancelBtn'; b.textContent = 'Cancel search';
    b.onclick = onCancel;
    s.append(b);
  }
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
  const ctrl = new AbortController();
  const cancel = () => ctrl.abort();
  try {
    let candidates = [];
    if (/magic/i.test(game)) { setStatus('Searching Scryfall…', false, true, cancel); candidates = await searchMTG(name, ctrl.signal); }
    else if (/pok/i.test(game)) { setStatus('Searching Pokémon TCG…', false, true, cancel); candidates = await searchPokemon(name, ctrl.signal); }
    else { setStatus('No card database for this game — keeping your photo & name.'); return; }

    if (!candidates.length) { setStatus('No match found — check the name and Look up again.', true); return; }

    // One card per distinct name, so you choose Virizion vs Virizion ex (not every printing).
    const seen = new Set();
    const distinct = candidates.filter(h => { const k = (h.name || '').toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });

    if (distinct.length === 1) {
      applyHit(distinct[0]);
      setStatus('Filled from ' + distinct[0].source + ' ✓');
    } else {
      setStatus(distinct.length + ' matches — pick the right card.');
      showChooser(distinct, 'Which card?', h => h.name, h => { applyHit(h); setStatus('Filled: ' + h.name + ' ✓'); });
    }
  } catch (e) {
    if (e.name === 'AbortError') setStatus('Search cancelled.');
    else setStatus('Lookup failed (offline?). Fields stay editable.', true);
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
  if (h.price != null) $('f_price').value = h.price;
  if (h.image) { currentImage = h.image; showPreview(currentImage); }
  // carry deck-legality metadata that has no visible form field
  currentMeta = {
    cat: h.cat,
    noLimit: !!h.noLimit,
    basicPokemon: !!h.basicPokemon,
    aceSpec: !!h.aceSpec,
    setCode: h.setCode || '',
    number: h.number || ''
  };
}

// --- Mappers: raw API card -> our hit shape (image = official art) ---
function mapMTG(c) {
  const colours = (c.colors && c.colors.length) ? c.colors.join('') : 'Colourless';
  const uris = c.image_uris || c.card_faces?.[0]?.image_uris || {};
  const tl = (c.type_line || '').toLowerCase();
  return {
    source: 'Scryfall',
    name: c.name,
    type: c.type_line || colours,
    cost: c.mana_cost || '',
    power: (c.power && c.toughness) ? `${c.power}/${c.toughness}` : '',
    rarity: c.rarity || '',
    price: c.prices ? parseFloat(c.prices.usd || c.prices.usd_foil) || null : null,
    image: uris.normal || null,
    thumb: uris.small || uris.normal || null,
    sub: [c.set_name, c.rarity].filter(Boolean).join(' · '),
    cat: tl.includes('land') ? 'land' : 'spell',
    noLimit: tl.includes('basic') && tl.includes('land'),
    basicPokemon: false,
    aceSpec: false,
    setCode: (c.set || '').toUpperCase(),
    number: c.collector_number || ''
  };
}
// Best available price for a Pokémon card: TCGPlayer (USD) market→mid→low,
// then fall back to Cardmarket (EUR) trend/average.
function pokePrice(c) {
  const p = c.tcgplayer && c.tcgplayer.prices;
  if (p) {
    for (const field of ['market', 'mid', 'low']) {
      for (const k of Object.keys(p)) {
        if (p[k] && typeof p[k][field] === 'number') return p[k][field];
      }
    }
  }
  const cm = c.cardmarket && c.cardmarket.prices;
  if (cm) return cm.trendPrice || cm.averageSellPrice || cm.avg30 || null;
  return null;
}
function mapPokemon(c) {
  const cost = c.attacks && c.attacks[0] && c.attacks[0].cost ? c.attacks[0].cost.join(' ') : '';
  const sup = c.supertype || '';
  const subs = c.subtypes || [];
  const cat = /pok/i.test(sup) ? 'pokemon' : /energy/i.test(sup) ? 'energy' : 'trainer';
  return {
    source: 'Pokémon TCG',
    name: c.name,
    type: (c.types || []).join(', '),
    cost,
    power: c.hp ? 'HP ' + c.hp : '',
    rarity: c.rarity || '',
    price: pokePrice(c),
    image: c.images ? c.images.large : null,
    thumb: c.images ? c.images.small : null,
    sub: [c.set?.name, c.rarity].filter(Boolean).join(' · '),
    cat,
    noLimit: cat === 'energy' && subs.includes('Basic'),
    basicPokemon: cat === 'pokemon' && subs.includes('Basic'),
    aceSpec: subs.includes('ACE SPEC') || /ace spec/i.test(c.rarity || ''),
    setCode: c.set ? (c.set.ptcgoCode || c.set.id || '') : '',
    number: c.number || ''
  };
}

// Scryfall — Magic: The Gathering (free, no key, fuzzy name match)
async function lookupMTG(name, signal) {
  const r = await fetch('https://api.scryfall.com/cards/named?fuzzy=' + encodeURIComponent(name), { signal });
  if (!r.ok) return null;
  const c = await r.json();
  if (c.object === 'error') return null;
  return mapMTG(c);
}
async function searchMTG(name, signal) {
  const r = await fetch('https://api.scryfall.com/cards/search?order=name&q=' +
    encodeURIComponent(name), { signal });
  if (!r.ok) return [];
  const j = await r.json();
  return (j.data || []).slice(0, 30).map(mapMTG);
}

// Pokémon TCG API (free, no key needed for light use)
async function lookupPokemon(name, signal) {
  const url = 'https://api.pokemontcg.io/v2/cards?pageSize=1&q=' +
    encodeURIComponent('name:"' + name + '"');
  const r = await fetch(url, { signal });
  if (!r.ok) return null;
  const j = await r.json();
  const c = j.data && j.data[0];
  return c ? mapPokemon(c) : null;
}
async function searchPokemon(name, signal) {
  const url = 'https://api.pokemontcg.io/v2/cards?pageSize=30&orderBy=name&q=' +
    encodeURIComponent('name:"' + name + '*"');
  const r = await fetch(url, { signal });
  if (!r.ok) return [];
  const j = await r.json();
  return (j.data || []).map(mapPokemon);
}

// --- All printings for a card (for the art picker) ---
async function printsMTG(name) {
  const r = await fetch('https://api.scryfall.com/cards/search?unique=prints&order=released&q=' +
    encodeURIComponent('!"' + name + '"'));
  if (!r.ok) return [];
  const j = await r.json();
  return (j.data || []).filter(c => c.image_uris || c.card_faces).map(mapMTG);
}
async function printsPokemon(name) {
  const r = await fetch('https://api.pokemontcg.io/v2/cards?pageSize=60&orderBy=-set.releaseDate&q=' +
    encodeURIComponent('name:"' + name + '"'));
  if (!r.ok) return [];
  const j = await r.json();
  return (j.data || []).filter(c => c.images).map(mapPokemon);
}

function setArtStatus(msg, isErr, loading) {
  const s = $('artStatus');
  if (!msg) { s.hidden = true; s.innerHTML = ''; return; }
  s.hidden = false;
  s.innerHTML = (loading ? '<span class="spinner"></span>' : '') + '<span></span>';
  s.lastChild.textContent = msg;
  s.classList.toggle('err', !!isErr);
}

// Shared picker grid (used by Look up's candidate chooser and the art picker).
function showChooser(list, title, captionFn, onPick) {
  $('artTitle').textContent = title;
  const grid = $('artResults');
  grid.innerHTML = '';
  list.forEach(h => {
    const fig = document.createElement('figure');
    fig.innerHTML = `<img src="${h.thumb || h.image}" alt="">
      <figcaption>${esc(captionFn(h))}</figcaption>`;
    fig.onclick = () => { onPick(h); $('artDialog').close(); };
    grid.append(fig);
  });
  if (!$('artDialog').open) $('artDialog').showModal();
}

async function openArtPicker() {
  const game = $('f_game').value;
  const name = $('f_name').value.trim();
  if (!name) { setStatus('Enter a name first, then Choose art.', true); return; }
  const isMagic = /magic/i.test(game), isPoke = /pok/i.test(game);
  if (!isMagic && !isPoke) { setStatus('Art picker only works for Magic & Pokémon.', true); return; }
  $('artResults').innerHTML = '';
  setArtStatus('Loading printings…', false, true);
  $('artTitle').textContent = 'Choose art / printing';
  $('artDialog').showModal();
  try {
    const prints = isMagic ? await printsMTG(name) : await printsPokemon(name);
    if (!prints.length) { setArtStatus('No printings found for “' + name + '”.', true); return; }
    setArtStatus(prints.length + ' printing' + (prints.length > 1 ? 's' : '') + ' — tap one.');
    showChooser(prints, 'Choose art / printing', h => h.sub || '', h => { applyHit(h); setStatus('Art set from ' + h.source + ' ✓'); });
  } catch (e) {
    setArtStatus('Failed to load printings (offline?).', true);
  }
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
  const ctrl = new AbortController();
  setFindStatus('Searching ' + game + '…', false, true, () => ctrl.abort());
  try {
    const hits = /magic/i.test(game) ? await searchMTG(name, ctrl.signal) : await searchPokemon(name, ctrl.signal);
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
    if (e.name === 'AbortError') setFindStatus('Search cancelled.');
    else setFindStatus('Search failed (offline?).', true);
  } finally {
    $('findGoBtn').disabled = false;
  }
}
function setFindStatus(msg, isErr, loading, onCancel) {
  renderStatus($('findStatus'), msg, isErr, loading, onCancel);
}

// ---------- Save / delete ----------
async function save(next) {
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
    price: $('f_price').value !== '' ? parseFloat($('f_price').value) : null,
    qty: parseInt($('f_qty').value, 10) || 1,
    location: $('f_loc').value.trim(),
    tags: parseTags($('f_tags').value),
    image: currentImage || null,
    meta: {
      cat: currentMeta.cat || null,
      noLimit: !!currentMeta.noLimit,
      basicPokemon: !!currentMeta.basicPokemon,
      aceSpec: !!currentMeta.aceSpec,
      setCode: currentMeta.setCode || '',
      number: currentMeta.number || '',
      condition: $('f_condition').value || '',
      wishlist: $('f_wishlist').checked
    },
    updated: new Date().toISOString()
  };
  try {
    await dataPut(card);
  } catch (e) {
    alert('Saved locally, but online sync failed: ' + e.message + '\nIt will need re-saving when sync works.');
  }
  await reload();
  if (next) {
    // Rapid batch mode: straight into a fresh card with the camera open.
    openDialog(null);
    startCamera();
  } else {
    $('cardDialog').close();
  }
}
function money(n) { return (Math.round(n * 100) / 100).toFixed(2); }

// Open a price search for the current card so a blank price can be filled by hand.
function openPriceSearch() {
  const name = $('f_name').value.trim();
  if (!name) { setStatus('Enter a name first.', true); return; }
  const game = $('f_game').value.replace(/:.*$/, ''); // "Magic" / "Pokémon"
  const q = encodeURIComponent(`${name} ${game} card price`);
  window.open('https://www.google.com/search?q=' + q, '_blank', 'noopener');
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
  $('syncBtn').textContent = cfg ? 'Synced' : 'Sync';
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
function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function exportCSV() {
  const cols = ['name', 'game', 'type', 'cost', 'power', 'rarity', 'condition', 'price', 'qty', 'location', 'tags'];
  const rows = [cols.join(',')];
  cards.forEach(c => rows.push(cols.map(k =>
    csvCell(k === 'tags' ? (c.tags || []).join('; ') : k === 'condition' ? (c.meta?.condition || '') : c[k])
  ).join(',')));
  const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'joshcards-collection.csv';
  a.click();
}

// ---------- Deck building ----------
let editingDeck = null;

async function openDecks() {
  await loadDecks();
  renderDeckList();
  $('decksDialog').showModal();
}
function renderDeckList() {
  const box = $('decksList');
  box.innerHTML = '';
  if (!decks.length) { box.innerHTML = '<p class="hint">No decks yet. Create one above.</p>'; return; }
  decks.forEach(d => {
    const leg = legality(d);
    const row = document.createElement('div');
    row.className = 'result';
    row.innerHTML = `<div style="flex:1">
        <div class="rn">${esc(d.name || 'Untitled')}</div>
        <div class="rs">${esc(deckGameShort(d.game))} · ${leg.total}/${leg.target} cards ·
          <span class="${leg.legal ? 'ok' : 'bad'}">${leg.legal ? 'Legal ✓' : 'Not legal'}</span></div>
      </div>`;
    row.onclick = () => openDeckEditor(d);
    box.append(row);
  });
}
function deckGameShort(g) { return /magic/i.test(g) ? 'MTG' : 'Pokémon'; }

function newDeck(game) {
  const d = { id: 'deck_' + Date.now().toString(36), name: game === 'mtg' ? 'New MTG deck' : 'New Pokémon deck',
    game: game === 'mtg' ? 'Magic: The Gathering' : 'Pokémon', entries: {}, updated: new Date().toISOString() };
  openDeckEditor(d, true);
}
async function cloneDeck() {
  if (!editingDeck) return;
  const copy = { id: 'deck_' + Date.now().toString(36), name: (editingDeck.name || 'Deck') + ' (copy)',
    game: editingDeck.game, entries: { ...editingDeck.entries }, updated: new Date().toISOString() };
  await dataPutDeck(copy);
  openDeckEditor(copy);
}
function openDeckEditor(deck, isNew) {
  editingDeck = { ...deck, entries: { ...(deck.entries || {}) } };
  $('deck_name').value = editingDeck.name || '';
  $('deckSearch').value = '';
  $('decksDialog').close();
  renderDeckEditor();
  $('deckEditor').showModal();
  if (isNew) dataPutDeck(editingDeck); // persist immediately so it shows in the list
}
function deckCards() {
  // catalogue cards for this deck's game, newest matches first by name
  return cards.filter(c => deckGameShort(c.game) === deckGameShort(editingDeck.game))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}
function selectedDeckCards(deck) {
  const byId = Object.fromEntries(cards.map(c => [c.id, c]));
  return Object.entries(deck.entries || {})
    .map(([id, count]) => ({ card: byId[id], count }))
    .filter(x => x.card && x.count > 0)
    .sort((a, b) => {
      const ac = cardMeta(a.card).cat || '';
      const bc = cardMeta(b.card).cat || '';
      return ac.localeCompare(bc) || (a.card.name || '').localeCompare(b.card.name || '');
    });
}
function renderDeckEditor() {
  renderLegality();
  const q = $('deckSearch').value.trim().toLowerCase();
  const list = $('deckCardList');
  list.innerHTML = '';
  const pool = deckCards().filter(c => !q || (c.name || '').toLowerCase().includes(q));
  if (!pool.length) { list.innerHTML = '<p class="hint">No ' + deckGameShort(editingDeck.game) + ' cards in your catalogue yet — add some first.</p>'; return; }
  pool.forEach(c => {
    const count = editingDeck.entries[c.id] || 0;
    const m = cardMeta(c);
    const owned = c.qty || 1;
    const short = count > owned ? ` · <span class="bad">need ${count - owned} more</span>` : '';
    const row = document.createElement('div');
    row.className = 'deckRow';
    row.innerHTML = `<img src="${c.image || 'icons/icon.svg'}" alt="">
      <div class="dn">${esc(c.name)}<br><small>${esc(m.cat)} · own ${owned}${short}</small></div>`;
    const step = document.createElement('div');
    step.className = 'stepper';
    const minus = document.createElement('button'); minus.type = 'button'; minus.textContent = '−';
    const ct = document.createElement('span'); ct.className = 'ct'; ct.textContent = count;
    const plus = document.createElement('button'); plus.type = 'button'; plus.textContent = '+';
    minus.onclick = () => changeCount(c.id, -1);
    plus.onclick = () => changeCount(c.id, +1);
    step.append(minus, ct, plus);
    row.append(step);
    list.append(row);
  });
}
function changeCount(cardId, delta) {
  const cur = editingDeck.entries[cardId] || 0;
  const next = Math.max(0, cur + delta);
  if (next === 0) delete editingDeck.entries[cardId]; else editingDeck.entries[cardId] = next;
  editingDeck.updated = new Date().toISOString();
  renderDeckEditor();
  dataPutDeck(editingDeck);
}

const PLAYTEST_FORMATS = {
  mtg_forge: {
    game: 'MTG',
    label: 'MTG - Forge / Moxfield / Untap plain text',
    ext: 'txt',
    note: 'Use this for Forge vs-AI play, Moxfield goldfishing, or Untap.in browser play. Most tools also accept illegal/casual lists.',
    links: [
      ['Forge releases', 'https://github.com/Card-Forge/forge/releases', 'Free download, best option here for MTG vs AI.'],
      ['Moxfield', 'https://moxfield.com/', 'Browser deck builder with solo playtest/goldfish.'],
      ['Untap.in', 'https://untap.in/', 'Browser tabletop for playing with people.']
    ],
    build: buildMtgPlain
  },
  mtg_arena: {
    game: 'MTG',
    label: 'MTG Arena import text',
    ext: 'txt',
    note: 'Arena import works best when cards include set and collector number. Missing details fall back to quantity + name.',
    links: [
      ['MTG Arena', 'https://magic.wizards.com/en/mtgarena', 'Free client with deck import and online play.']
    ],
    build: buildMtgArena
  },
  pokemon_live: {
    game: 'Pokemon',
    label: 'Pokemon TCG Live / PTCG-sim text',
    ext: 'txt',
    note: 'Pokemon imports need set code and card number. Re-run Look up or Choose art on older cards if a line is missing those details.',
    links: [
      ['Pokemon TCG Live', 'https://tcg.pokemon.com/en-us/tcgl/', 'Official free app for online play.'],
      ['PTCG-sim', 'https://ptcgsim.online/', 'Browser solo/multiplayer tabletop simulator.']
    ],
    build: buildPokemonLive
  }
};

function deckFormatOptions(deck) {
  return /magic/i.test(deck.game)
    ? ['mtg_forge', 'mtg_arena']
    : ['pokemon_live'];
}
function exportLineName(card) {
  return String(card.name || '').replace(/\s+/g, ' ').trim();
}
function buildMtgPlain(deck) {
  return selectedDeckCards(deck)
    .map(({ card, count }) => `${count} ${exportLineName(card)}`)
    .join('\n');
}
function buildMtgArena(deck) {
  return selectedDeckCards(deck)
    .map(({ card, count }) => {
      const meta = card.meta || {};
      const set = meta.setCode ? ` (${String(meta.setCode).toUpperCase()})` : '';
      const num = meta.number ? ` ${meta.number}` : '';
      return `${count} ${exportLineName(card)}${set}${num}`;
    })
    .join('\n');
}
function buildPokemonLive(deck) {
  const groups = { pokemon: [], trainer: [], energy: [], other: [] };
  selectedDeckCards(deck).forEach(({ card, count }) => {
    const meta = card.meta || {};
    const m = cardMeta(card);
    const set = meta.setCode ? ` ${String(meta.setCode).toUpperCase()}` : '';
    const num = meta.number ? ` ${meta.number}` : '';
    const line = `${count} ${exportLineName(card)}${set}${num}`;
    (groups[m.cat] || groups.other).push(line);
  });
  const sections = [];
  if (groups.pokemon.length) sections.push(`Pokemon: ${sumGroup(groups.pokemon)}\n${groups.pokemon.join('\n')}`);
  if (groups.trainer.length) sections.push(`Trainer: ${sumGroup(groups.trainer)}\n${groups.trainer.join('\n')}`);
  if (groups.energy.length) sections.push(`Energy: ${sumGroup(groups.energy)}\n${groups.energy.join('\n')}`);
  if (groups.other.length) sections.push(`Other: ${sumGroup(groups.other)}\n${groups.other.join('\n')}`);
  return sections.join('\n\n');
}
function sumGroup(lines) {
  return lines.reduce((sum, line) => sum + (parseInt(line, 10) || 0), 0);
}
function renderPlaytestExport() {
  if (!editingDeck) return;
  const key = $('playtestFormat').value || deckFormatOptions(editingDeck)[0];
  const fmt = PLAYTEST_FORMATS[key];
  const text = fmt.build(editingDeck);
  const leg = legality(editingDeck);
  $('deckExportText').value = text;
  $('playtestNote').textContent = fmt.note;
  $('playtestSummary').innerHTML =
    `<div class="lhead"><span>${esc(editingDeck.name || 'Untitled')}</span>
      <span class="${leg.legal ? 'ok' : 'bad'}">${leg.legal ? 'Legal' : 'Not legal'}</span></div>
     <div class="brk">${leg.total}/${leg.target} cards. You can still export casual or illegal lists when a platform allows it.</div>`;
  $('playtestLinks').innerHTML = fmt.links.map(([label, url, desc]) =>
    `<a href="${url}" target="_blank" rel="noopener">
      <strong>${esc(label)}</strong><span>${esc(desc)}</span>
    </a>`).join('');
}
function openPlaytest() {
  const opts = deckFormatOptions(editingDeck);
  const sel = $('playtestFormat');
  sel.innerHTML = '';
  opts.forEach(k => sel.append(new Option(PLAYTEST_FORMATS[k].label, k)));
  renderPlaytestExport();
  $('deckEditor').close();
  $('playtestDialog').showModal();
}
async function copyDeckExport() {
  const text = $('deckExportText').value;
  if (!text) return;
  await navigator.clipboard.writeText(text);
  $('copyDeckBtn').textContent = 'Copied';
  setTimeout(() => { $('copyDeckBtn').textContent = 'Copy list'; }, 1200);
}
function downloadDeckExport() {
  const key = $('playtestFormat').value;
  const fmt = PLAYTEST_FORMATS[key];
  const name = (editingDeck?.name || 'deck').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'deck';
  const blob = new Blob([$('deckExportText').value], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name}-${key}.${fmt.ext}`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// Goldfish: draw a random opening hand from the current deck.
function drawHand() {
  const byId = Object.fromEntries(cards.map(c => [c.id, c]));
  const pile = [];
  for (const [id, n] of Object.entries(editingDeck.entries || {})) {
    const c = byId[id]; if (!c) continue;
    for (let i = 0; i < n; i++) pile.push(c);
  }
  // Fisher–Yates shuffle
  for (let i = pile.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pile[i], pile[j]] = [pile[j], pile[i]];
  }
  const hand = pile.slice(0, 7);
  const isMtg = /magic/i.test(editingDeck.game);
  let note = `${pile.length} cards in deck.`;
  if (!isMtg) {
    const hasBasic = hand.some(c => cardMeta(c).basicPokemon);
    note += hasBasic ? ' Hand has a Basic Pokémon ✓ (playable).' : ' ⚠ No Basic Pokémon — you would mulligan this hand.';
  } else {
    const lands = hand.filter(c => cardMeta(c).cat === 'land').length;
    note += ` ${lands} land${lands === 1 ? '' : 's'} in hand.`;
  }
  $('handSummary').textContent = note;
  const grid = $('handGrid');
  grid.innerHTML = '';
  if (!hand.length) { grid.innerHTML = '<p class="hint">Add cards to the deck first.</p>'; return; }
  hand.forEach(c => {
    const fig = document.createElement('figure');
    fig.innerHTML = `<img src="${c.image || 'icons/icon.svg'}" alt=""><figcaption>${esc(c.name)}</figcaption>`;
    grid.append(fig);
  });
}
function openSampleHand() {
  drawHand();
  if (!$('handDialog').open) $('handDialog').showModal();
}

// The legality engine.
function legality(deck) {
  const isMtg = /magic/i.test(deck.game);
  const target = 60;
  const entries = deck.entries || {};
  const byId = Object.fromEntries(cards.map(c => [c.id, c]));
  let total = 0, aceSpec = 0, hasBasicPokemon = false, owned = 0, value = 0, shortItems = 0;
  const byCat = {};
  const byName = {};        // for the max-4 rule (counts copies across printings of a name)
  const nameNoLimit = {};
  for (const [id, n] of Object.entries(entries)) {
    const c = byId[id]; if (!c) continue;
    const m = cardMeta(c);
    total += n;
    byCat[m.cat] = (byCat[m.cat] || 0) + n;
    if (m.basicPokemon) hasBasicPokemon = true;
    if (m.aceSpec) aceSpec += n;
    const key = (c.name || '').toLowerCase();
    byName[key] = (byName[key] || 0) + n;
    if (m.noLimit) nameNoLimit[key] = true;
    const have = c.qty || 1;
    owned += Math.min(n, have);
    if (n > have) shortItems++;
    if (c.price != null) value += c.price * n;
  }
  const overFour = Object.entries(byName).filter(([k, n]) => n > 4 && !nameNoLimit[k]).map(([k]) => k);
  const checks = [];
  checks.push({ label: `Exactly 60 cards (have ${total})`, ok: total === target });
  checks.push({ label: overFour.length ? `Max 4 copies — too many: ${overFour.join(', ')}` : 'Max 4 copies of any card', ok: overFour.length === 0 });
  if (isMtg) {
    // (lands aren't strictly required, but a deck with 0 land can't function — flag as a warning-style check)
    checks.push({ label: `Has lands (${byCat.land || 0})`, ok: (byCat.land || 0) > 0 });
  } else {
    checks.push({ label: 'At least one Basic Pokémon', ok: hasBasicPokemon });
    checks.push({ label: `Max 1 ACE SPEC (have ${aceSpec})`, ok: aceSpec <= 1 });
  }
  const legal = checks.every(c => c.ok);
  return { isMtg, target, total, byCat, checks, legal, owned, value, shortItems };
}
function renderLegality() {
  const leg = legality(editingDeck);
  const brk = leg.isMtg
    ? `Lands ${leg.byCat.land || 0} · Spells ${leg.byCat.spell || 0}`
    : `Pokémon ${leg.byCat.pokemon || 0} · Trainer ${leg.byCat.trainer || 0} · Energy ${leg.byCat.energy || 0}`;
  $('deckLegality').innerHTML =
    `<div class="lhead"><span>${leg.total}/${leg.target}</span>
       <span class="${leg.legal ? 'ok' : 'bad'}">${leg.legal ? 'LEGAL ✓' : 'Not legal yet'}</span></div>` +
    leg.checks.map(c => `<div class="chk ${c.ok ? 'ok' : 'bad'}">${c.ok ? '✓' : '✗'} <span>${esc(c.label)}</span></div>`).join('') +
    `<div class="brk">${brk}</div>` +
    `<div class="brk">You own ${leg.owned}/${leg.total} cards in this deck` +
      (leg.shortItems ? ` · <span class="bad">${leg.shortItems} card(s) need more copies</span>` : '') +
      (leg.value ? ` · ~$${money(leg.value)} value` : '') + `</div>`;
}

// ---------- Collection dashboard ----------
function showStats() { renderStats(); $('statsDialog').showModal(); }
function renderStats() {
  const byGame = {};
  let totalCards = 0, totalValue = 0, priced = 0;
  cards.forEach(c => {
    if (c.meta?.wishlist) return; // wishlist = want, not owned
    const g = c.game || 'Other';
    const qty = c.qty || 1;
    const val = (c.price != null ? c.price : 0) * qty;
    byGame[g] ||= { rows: 0, qty: 0, value: 0 };
    byGame[g].rows++; byGame[g].qty += qty; byGame[g].value += val;
    totalCards += qty; totalValue += val;
    if (c.price != null) priced += qty;
  });
  $('statsTotals').innerHTML = `
    <div class="box"><div class="big">${cards.length}</div><div class="lbl">unique cards</div></div>
    <div class="box"><div class="big">${totalCards}</div><div class="lbl">total (incl. qty)</div></div>
    <div class="box"><div class="big">$${money(totalValue)}</div><div class="lbl">est. value</div></div>`;
  const games = Object.entries(byGame).sort((a, b) => b[1].value - a[1].value);
  let html = '<tr><th>Game</th><th class="num">Unique</th><th class="num">Total</th><th class="num">Value</th></tr>';
  games.forEach(([g, s]) => {
    html += `<tr><td>${esc(g)}</td><td class="num">${s.rows}</td><td class="num">${s.qty}</td><td class="num">$${money(s.value)}</td></tr>`;
  });
  html += `<tr class="tot"><td>Total</td><td class="num">${cards.length}</td><td class="num">${totalCards}</td><td class="num">$${money(totalValue)}</td></tr>`;
  $('statsTable').innerHTML = html;
}

function setStatsStatus(msg, isErr, loading) {
  renderStatus($('statsStatus'), msg, isErr, loading);
}
// Re-query Magic & Pokémon cards by name to fill/update their market price.
async function refreshPrices() {
  const targets = cards.filter(c => /magic|pok/i.test(c.game || ''));
  if (!targets.length) { setStatsStatus('No Magic or Pokémon cards to price.', true); return; }
  const btn = $('refreshPricesBtn');
  btn.disabled = true;
  let done = 0, updated = 0;
  for (const c of targets) {
    setStatsStatus(`Pricing ${++done}/${targets.length}… ${esc(c.name)}`, false, true);
    try {
      const hit = /magic/i.test(c.game) ? await lookupMTG(c.name) : await lookupPokemon(c.name);
      if (hit) {
        const meta = {
          cat: hit.cat,
          noLimit: !!hit.noLimit,
          basicPokemon: !!hit.basicPokemon,
          aceSpec: !!hit.aceSpec,
          setCode: hit.setCode || c.meta?.setCode || '',
          number: hit.number || c.meta?.number || ''
        };
        await dataPut({ ...c, price: hit.price != null ? hit.price : c.price, meta, updated: new Date().toISOString() });
        if (hit.price != null) updated++;
      }
    } catch { /* skip this card, keep going */ }
    await new Promise(r => setTimeout(r, 120)); // be gentle on the free APIs
  }
  await reload();
  btn.disabled = false;
  renderStats();
  setStatsStatus(`Updated ${updated} of ${targets.length} card prices.`);
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
  $('s_collection').value = cfg?.collection || makeCollectionId();
  setSyncStatus(cfg ? 'Sync is on for collection ' + cleanCollectionId(cfg.collection) + '.' : 'Sync is off. Add your own Supabase project to share across devices.');
  $('syncDialog').showModal();
}
async function testSync() {
  const url = $('s_url').value.trim().replace(/\/+$/, ''), key = $('s_key').value.trim();
  const collection = cleanCollectionId($('s_collection').value);
  $('s_collection').value = collection;
  if (!url || !key) { setSyncStatus('Enter both URL and key.', true); return; }
  setSyncStatus('Testing...');
  try {
    const rows = await remoteGetAll({ url, key, collection });
    saveSyncCfg(url, key, collection);
    // push anything local that isn't on the server yet
    for (const c of await allCards()) await remoteUpsert({ url, key, collection }, c);
    for (const d of await allDecksLocal()) await remoteUpsertDeck({ url, key, collection }, d);
    await reload();
    setSyncStatus(`Connected - ${rows.length} cards in this collection, local cards uploaded.`);
  } catch (e) {
    setSyncStatus('Failed: ' + e.message + ' - check URL, key, Collection ID, and the setup SQL.', true);
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
  $('emptyAddBtn').onclick = () => openDialog(null);
  $('emptyFindBtn').onclick = () => { setFindStatus(''); $('findResults').innerHTML = ''; $('findDialog').showModal(); };
  $('findGoBtn').onclick = runFind;
  $('find_name').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); runFind(); } });
  $('findCloseBtn').onclick = () => $('findDialog').close();
  $('search').oninput = render;
  $('filterGame').onchange = render;
  $('filterTag').onchange = render;
  $('filterOwn').onchange = render;
  $('sortBy').onchange = render;
  applyTheme(localStorage.getItem('joshcards_theme') || 'dark');
  $('themeBtn').onclick = () => applyTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light');
  $('randomBtn').onclick = randomGame;
  $('detailCloseBtn').onclick = () => $('detailDialog').close();
  $('detailEditBtn').onclick = () => { $('detailDialog').close(); openDialog(detailCard); };
  $('camBtn').onclick = startCamera;
  $('shotBtn').onclick = capture;
  $('fileInput').onchange = (e) => e.target.files[0] && fileToImage(e.target.files[0]);
  $('ocrToggle').checked = ocrEnabled();
  $('ocrToggle').onchange = () => setOcrEnabled($('ocrToggle').checked);
  $('lookupBtn').onclick = lookup;
  $('priceLookupBtn').onclick = openPriceSearch;
  $('artBtn').onclick = openArtPicker;
  $('artCloseBtn').onclick = () => $('artDialog').close();
  $('saveBtn').onclick = () => save(false);
  $('saveNextBtn').onclick = () => save(true);
  $('statsBtn').onclick = showStats;
  $('statsCloseBtn').onclick = () => $('statsDialog').close();
  $('decksBtn').onclick = openDecks;
  $('decksCloseBtn').onclick = () => $('decksDialog').close();
  $('newPokeDeck').onclick = () => newDeck('poke');
  $('newMtgDeck').onclick = () => newDeck('mtg');
  $('deckSearch').oninput = renderDeckEditor;
  $('deck_name').oninput = () => { if (editingDeck) { editingDeck.name = $('deck_name').value; dataPutDeck(editingDeck); } };
  $('playtestBtn').onclick = openPlaytest;
  $('sampleHandBtn').onclick = openSampleHand;
  $('deckCloneBtn').onclick = cloneDeck;
  $('exportCsvBtn').onclick = exportCSV;
  $('drawAgainBtn').onclick = drawHand;
  $('handCloseBtn').onclick = () => $('handDialog').close();
  $('playtestFormat').onchange = renderPlaytestExport;
  $('copyDeckBtn').onclick = copyDeckExport;
  $('downloadDeckBtn').onclick = downloadDeckExport;
  $('playtestCloseBtn').onclick = () => { $('playtestDialog').close(); if (editingDeck) $('deckEditor').showModal(); };
  $('deckCloseBtn').onclick = () => { $('deckEditor').close(); openDecks(); };
  $('deckDeleteBtn').onclick = async () => {
    if (editingDeck && confirm('Delete this deck?')) { await dataDeleteDeck(editingDeck.id); $('deckEditor').close(); openDecks(); }
  };
  $('refreshPricesBtn').onclick = refreshPrices;
  $('deleteBtn').onclick = removeCard;
  $('cancelBtn').onclick = () => { stopCamera(); $('cardDialog').close(); };
  $('cardDialog').addEventListener('close', stopCamera);
  $('dupBtn').onclick = () => { renderDuplicates(); $('dupDialog').showModal(); };
  $('dupMatch').onchange = renderDuplicates;
  $('dupCloseBtn').onclick = () => $('dupDialog').close();
  $('syncBtn').onclick = openSync;
  $('syncSaveBtn').onclick = () => { saveSyncCfg($('s_url').value.trim(), $('s_key').value.trim(), $('s_collection').value.trim()); reload(); $('syncDialog').close(); };
  $('syncCloseBtn').onclick = () => $('syncDialog').close();
  $('syncTestBtn').onclick = testSync;
  $('exportBtn').onclick = exportJSON;
  $('importInput').onchange = (e) => e.target.files[0] && importJSON(e.target.files[0]);

  // Add-to-home-screen helper (Chrome/Android).
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    if (localStorage.getItem('joshcards_install_dismissed')) return;
    deferredPrompt = e;
    $('installBanner').hidden = false;
  });
  $('installBtn').onclick = async () => {
    $('installBanner').hidden = true;
    if (deferredPrompt) { deferredPrompt.prompt(); deferredPrompt = null; }
  };
  $('installDismiss').onclick = () => { $('installBanner').hidden = true; localStorage.setItem('joshcards_install_dismissed', '1'); };

  // When the connection comes back, flush queued changes and refresh.
  window.addEventListener('online', () => reload());

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
init();
