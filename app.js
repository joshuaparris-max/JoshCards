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
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
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
  await putCard(card);
  await reload();
  $('cardDialog').close();
}
async function removeCard() {
  if (editingId && confirm('Delete this card?')) {
    await delCard(editingId);
    await reload();
    $('cardDialog').close();
  }
}

async function reload() {
  cards = (await allCards()).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  render();
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
  for (const c of arr) { if (c && c.id) await putCard(c); }
  await reload();
  alert('Imported ' + arr.length + ' cards.');
}

// ---------- Wire up ----------
async function init() {
  fillSelect($('f_game'), GAMES, false);
  fillSelect($('filterGame'), GAMES, true, 'All games');
  fillSelect($('filterTag'), TAGS, true, 'All tags');
  await openDB();
  await reload();

  $('addBtn').onclick = () => openDialog(null);
  $('search').oninput = render;
  $('filterGame').onchange = render;
  $('filterTag').onchange = render;
  $('camBtn').onclick = startCamera;
  $('shotBtn').onclick = capture;
  $('fileInput').onchange = (e) => e.target.files[0] && fileToImage(e.target.files[0]);
  $('saveBtn').onclick = save;
  $('deleteBtn').onclick = removeCard;
  $('cancelBtn').onclick = () => { stopCamera(); $('cardDialog').close(); };
  $('cardDialog').addEventListener('close', stopCamera);
  $('exportBtn').onclick = exportJSON;
  $('importInput').onchange = (e) => e.target.files[0] && importJSON(e.target.files[0]);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
init();
