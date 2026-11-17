'use strict';

/* MY CLOSET MINI — stage 1: personal wardrobe stored on this device only. */

const CATEGORIES = [
  { id: 'tops', label: 'חולצות' },
  { id: 'knit', label: 'סריגים' },
  { id: 'pants', label: 'מכנסיים' },
  { id: 'skirts', label: 'חצאיות' },
  { id: 'dresses', label: 'שמלות' },
  { id: 'outer', label: 'ג׳קטים ומעילים' },
  { id: 'shoes', label: 'נעליים' },
  { id: 'bags', label: 'תיקים' },
  { id: 'accessories', label: 'אביזרים' },
  { id: 'other', label: 'אחר' },
];
const catLabel = (id) => (CATEGORIES.find((c) => c.id === id) || CATEGORIES[CATEGORIES.length - 1]).label;

const PHOTO_MAX = 1400;   // longest side of the stored photo, px
const THUMB_MAX = 480;    // longest side of the grid thumbnail, px
const AI_IMAGE_MAX = 384; // longest side of photos sent to the stylist, px
const INSP_MAX = 900;     // longest side of stored inspiration photos, px
const MAX_INSPIRATION = 8;
const BACKUP_FORMAT = 'my-closet-mini-backup';
const STYLIST_URL = (window.STYLIST_URL_OVERRIDE || 'https://stylist.my-closet-mini.workers.dev') + '/stylist';

/* ---------- Storage (IndexedDB, on this device only) ---------- */

const DB_NAME = 'my-closet-mini';
let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('items')) d.createObjectStore('items', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}
async function run(store, mode, work) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const req = work(s);
    if (req) req.onsuccess = () => { result = req.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('השמירה בוטלה'));
  });
}
const getAllItems = () => run('items', 'readonly', (s) => s.getAll());
const putItem = (item) => run('items', 'readwrite', (s) => s.put(item));
const deleteItem = (id) => run('items', 'readwrite', (s) => s.delete(id));
const putItems = (items) => run('items', 'readwrite', (s) => { items.forEach((it) => s.put(it)); });
const getMeta = async (key) => { const r = await run('meta', 'readonly', (s) => s.get(key)); return r ? r.value : undefined; };
const setMeta = (key, value) => run('meta', 'readwrite', (s) => s.put({ key, value }));

async function askPersistentStorage() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (!(await navigator.storage.persisted())) await navigator.storage.persist();
    }
  } catch (_) { /* not supported: ignore */ }
}

/* ---------- Images ---------- */

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('לא הצלחתי לקרוא את התמונה')); };
    img.src = url;
  });
}
function resizeToDataURL(img, max, quality) {
  const w0 = img.naturalWidth, h0 = img.naturalHeight;
  const scale = Math.min(1, max / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale)), h = Math.max(1, Math.round(h0 * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return c.toDataURL('image/jpeg', quality);
}
async function processPhoto(file) {
  const { img, url } = await loadImage(file);
  try {
    return { photo: resizeToDataURL(img, PHOTO_MAX, 0.85), thumb: resizeToDataURL(img, THUMB_MAX, 0.8) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ---------- Helpers ---------- */

const $ = (id) => document.getElementById(id);
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}
function formatDate(iso) {
  try { return new Date(iso).toLocaleString('he-IL', { dateStyle: 'medium', timeStyle: 'short' }); } catch (_) { return iso; }
}
const isStandalone = () => window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/* ---------- State & rendering ---------- */

let items = [];
let filter = 'all';
let query = '';

async function refresh() {
  items = await getAllItems();
  items.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  render();
}

function render() {
  const n = items.length;
  $('count').textContent = n === 0 ? 'ארון ריק' : n === 1 ? 'בגד אחד' : `${n} בגדים`;

  // chips
  const chips = $('chips');
  chips.textContent = '';
  const counts = {};
  items.forEach((it) => { counts[it.category] = (counts[it.category] || 0) + 1; });
  const mk = (id, label, count) => {
    const b = el('button', 'chip' + (filter === id ? ' active' : ''), label);
    if (count != null) b.appendChild(el('span', 'n', String(count)));
    b.onclick = () => { filter = id; render(); };
    chips.appendChild(b);
  };
  mk('all', 'הכל', n);
  CATEGORIES.forEach((c) => { if (counts[c.id]) mk(c.id, c.label, counts[c.id]); });
  if (filter !== 'all' && !counts[filter]) filter = 'all';

  // grid
  const q = query.trim();
  const visible = items.filter((it) =>
    (filter === 'all' || it.category === filter) &&
    (!q || (it.description || '').includes(q) || catLabel(it.category).includes(q)));
  const grid = $('grid');
  grid.textContent = '';
  visible.forEach((it) => grid.appendChild(card(it)));
  $('empty').hidden = n !== 0;
  if (n !== 0 && visible.length === 0) {
    grid.appendChild(el('p', 'muted', 'לא נמצאו בגדים מתאימים.'));
  }
}

function card(it) {
  const b = el('button', 'item' + (it.thumb ? '' : ' text-only'));
  b.setAttribute('aria-label', `${catLabel(it.category)}: ${it.description || 'בלי תיאור'}`);
  if (it.thumb) {
    const img = el('img', 'thumb');
    img.src = it.thumb;
    img.alt = '';
    img.loading = 'lazy';
    b.appendChild(img);
    const meta = el('div', 'meta');
    meta.appendChild(el('div', 'cat', catLabel(it.category)));
    if (it.description) { const d = el('div', 'desc', it.description); d.dir = 'auto'; meta.appendChild(d); }
    b.appendChild(meta);
  } else {
    const t = el('div', 'textcard');
    t.appendChild(el('div', 'cat', catLabel(it.category)));
    const big = el('div', 'big', it.description);
    big.dir = 'auto';
    t.appendChild(big);
    t.appendChild(el('div', 'tag', 'תיאור בלבד · בלי תמונה'));
    b.appendChild(t);
  }
  b.onclick = () => openItem(it);
  return b;
}

/* ---------- Add / edit sheet ---------- */

let editing = null;      // item being edited, or null for new
let draft = null;        // { category, photo, thumb }

function openSheet(id) { $(id).hidden = false; document.body.style.overflow = 'hidden'; }
function closeSheet(id) { $(id).hidden = true; document.body.style.overflow = ''; }

function openItem(it) {
  editing = it || null;
  draft = {
    category: it ? it.category : (filter !== 'all' ? filter : 'tops'),
    photo: it ? it.photo || null : null,
    thumb: it ? it.thumb || null : null,
  };
  $('itemTitle').textContent = it ? 'עריכת בגד' : 'בגד חדש';
  $('descInput').value = it ? it.description || '' : '';
  $('deleteBtn').hidden = !it;
  $('anchorBtn').hidden = !it;
  $('itemError').hidden = true;
  $('saveBtn').disabled = false;
  renderCatPicker();
  renderPhoto();
  openSheet('itemSheet');
}

function renderCatPicker() {
  const p = $('catPicker');
  p.textContent = '';
  CATEGORIES.forEach((c) => {
    const b = el('button', 'chip' + (draft.category === c.id ? ' active' : ''), c.label);
    b.type = 'button';
    b.onclick = () => { draft.category = c.id; renderCatPicker(); };
    p.appendChild(b);
  });
}

function renderPhoto() {
  const has = !!draft.photo;
  $('photoPreview').hidden = !has;
  if (has) $('photoPreview').src = draft.photo; else $('photoPreview').removeAttribute('src');
  $('photoEmpty').hidden = has;
  $('photoBox').classList.toggle('has-photo', has);
  $('changePhotoBtn').hidden = !has;
  $('removePhotoBtn').hidden = !has;
}

async function onPhotoChosen(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  $('photoBusy').hidden = false;
  $('saveBtn').disabled = true;
  try {
    const { photo, thumb } = await processPhoto(file);
    draft.photo = photo;
    draft.thumb = thumb;
    renderPhoto();
    $('itemError').hidden = true;
  } catch (err) {
    showItemError('לא הצלחתי לטעון את התמונה. נסי תמונה אחרת.');
  } finally {
    $('photoBusy').hidden = true;
    $('saveBtn').disabled = false;
  }
}

function showItemError(msg) { $('itemError').textContent = msg; $('itemError').hidden = false; }

async function saveItem() {
  const description = $('descInput').value.trim();
  if (!draft.photo && !description) {
    showItemError('צריך להוסיף תמונה או לכתוב תיאור (או את שניהם).');
    return;
  }
  const now = new Date().toISOString();
  const item = {
    id: editing ? editing.id : newId(),
    category: draft.category,
    description,
    photo: draft.photo || null,
    thumb: draft.thumb || null,
    createdAt: editing ? editing.createdAt : now,
    updatedAt: now,
  };
  $('saveBtn').disabled = true;
  try {
    await putItem(item);
    askPersistentStorage();
    closeSheet('itemSheet');
    await refresh();
    toast(editing ? 'השינויים נשמרו' : 'הבגד נוסף לארון');
  } catch (err) {
    showItemError('השמירה נכשלה. ייתכן שאין מספיק מקום באייפון.');
    $('saveBtn').disabled = false;
  }
}

async function removeItem() {
  if (!editing) return;
  if (!confirm('למחוק את הבגד הזה מהארון?')) return;
  await deleteItem(editing.id);
  closeSheet('itemSheet');
  await refresh();
  toast('הבגד נמחק');
}

/* ---------- Backup & restore ---------- */

async function openSettings() {
  $('settingsMsg').hidden = true;
  await renderSettings();
  openSheet('settingsSheet');
}

async function renderSettings() {
  const last = await getMeta('lastBackup');
  $('lastBackup').textContent = last ? `גיבוי אחרון: ${formatDate(last)}` : 'עדיין לא נשמר גיבוי.';
  let status = `בארון: ${items.length} בגדים (${items.filter((i) => i.photo).length} עם תמונה).`;
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const { usage } = await navigator.storage.estimate();
      if (usage) status += usage < 1048576
        ? ` נפח בשימוש: פחות מ-1MB.`
        : ` נפח בשימוש: ${(usage / 1048576).toFixed(1)}MB.`;
    }
  } catch (_) { /* ignore */ }
  if (isIOS() && !isStandalone()) status += ' כדי ש-Safari לא ימחק את הארון, פתחי את האפליקציה מהאייקון במסך הבית.';
  $('storageStatus').textContent = status;
  $('stylistStatus').textContent = (await getMeta('stylistPassword'))
    ? 'מחוברת — הסיסמה שמורה באייפון הזה.'
    : 'עוד לא מחוברת. מתחברים בלשונית „סטייליסטית”.';
}

function settingsMsg(text) { $('settingsMsg').textContent = text; $('settingsMsg').hidden = false; }

async function backup() {
  const all = await getAllItems();
  if (all.length === 0) { settingsMsg('הארון ריק — אין עדיין מה לגבות.'); return; }
  const data = {
    format: BACKUP_FORMAT, version: 2, exportedAt: new Date().toISOString(), items: all,
    style: (await getMeta('style')) || '',
    inspiration: (await getMeta('inspiration')) || [],
    favorites: (await getMeta('favorites')) || [],
  };
  const day = new Date().toISOString().slice(0, 10);
  const name = `my-closet-backup-${day}.json`;
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const file = new File([blob], name, { type: 'application/json' });

  let done = false;
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'גיבוי MY CLOSET' });
      done = true;
    } catch (err) {
      if (err && err.name === 'AbortError') { settingsMsg('הגיבוי בוטל. לא נשמר קובץ.'); return; }
      // fall through to download
    }
  }
  if (!done) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    done = true;
  }
  await setMeta('lastBackup', data.exportedAt);
  await renderSettings();
  settingsMsg(`נוצר קובץ גיבוי עם ${all.length} בגדים: ${name}`);
}

function validItem(it) {
  return it && typeof it.id === 'string' && typeof it.category === 'string' &&
    (typeof it.description === 'string') &&
    (it.photo == null || (typeof it.photo === 'string' && it.photo.startsWith('data:image/'))) &&
    (it.thumb == null || (typeof it.thumb === 'string' && it.thumb.startsWith('data:image/'))) &&
    (it.photo || it.description.trim());
}

async function onRestoreChosen(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (_) {
    settingsMsg('הקובץ הזה לא נראה כמו קובץ גיבוי של MY CLOSET.');
    return;
  }
  if (!data || data.format !== BACKUP_FORMAT || !Array.isArray(data.items)) {
    settingsMsg('הקובץ הזה לא נראה כמו קובץ גיבוי של MY CLOSET.');
    return;
  }
  const good = data.items.filter(validItem).map((it) => ({
    id: it.id,
    category: CATEGORIES.some((c) => c.id === it.category) ? it.category : 'other',
    description: it.description,
    photo: it.photo || null,
    thumb: it.thumb || it.photo || null,
    createdAt: it.createdAt || new Date().toISOString(),
    updatedAt: it.updatedAt || it.createdAt || new Date().toISOString(),
  }));
  const before = new Set(items.map((i) => i.id));
  const added = good.filter((i) => !before.has(i.id)).length;
  try {
    await putItems(good);
    askPersistentStorage();
  } catch (_) {
    settingsMsg('השחזור נכשל. ייתכן שאין מספיק מקום באייפון.');
    return;
  }
  // Style, inspiration, favorites (backup version 2+). Never overwrite what's already here.
  const extra = [];
  if (typeof data.style === 'string' && data.style.trim() && !((await getMeta('style')) || '').trim()) {
    await setMeta('style', data.style.slice(0, 6000));
    extra.push('הסגנון שלך');
  }
  if (Array.isArray(data.inspiration)) {
    const cur = (await getMeta('inspiration')) || [];
    if (cur.length === 0) {
      const insp = data.inspiration.filter((s) => typeof s === 'string' && s.startsWith('data:image/')).slice(0, MAX_INSPIRATION);
      if (insp.length) { await setMeta('inspiration', insp); extra.push(insp.length === 1 ? 'תמונת השראה אחת' : `${insp.length} תמונות השראה`); }
    }
  }
  if (Array.isArray(data.favorites)) {
    const cur = (await getMeta('favorites')) || [];
    const have = new Set(cur.map((f) => f.id));
    const add = data.favorites.filter((f) => f && typeof f.id === 'string' && !have.has(f.id) && Array.isArray(f.itemIds));
    if (add.length) { await setMeta('favorites', cur.concat(add)); extra.push(add.length === 1 ? 'לוק אהוב אחד' : `${add.length} לוקים אהובים`); }
  }

  await refresh();
  await renderSettings();
  await renderStylist();
  const skipped = data.items.length - good.length;
  let msg = `השחזור הושלם: ${good.length} בגדים בקובץ, ${added} חדשים נוספו לארון.`;
  if (extra.length) msg += ` שוחזרו גם: ${extra.join(', ')}.`;
  if (skipped) msg += ` ${skipped} פריטים פגומים דולגו.`;
  settingsMsg(msg);
}

/* ---------- Stylist ---------- */

const QUICK_REQUESTS = ['לוק למחר', 'לוק לעבודה', 'לוק לערב בחוץ', 'לוק נוח לסופ״ש', 'משהו שעוד לא לבשתי'];
let anchorId = null;   // item the look must include
let currentLook = null; // { title, itemIds, explanation, tip, request, anchorId, excluded, savedId }
const aiImageCache = new Map();

function setTab(name) {
  const stylist = name === 'stylist';
  $('closetView').hidden = stylist;
  $('stylistView').hidden = !stylist;
  $('tabCloset').classList.toggle('active', !stylist);
  $('tabStylist').classList.toggle('active', stylist);
  $('addBtn').classList.toggle('ghost', stylist);
  window.scrollTo(0, 0);
  if (stylist) renderStylist();
}

const itemById = (id) => items.find((i) => i.id === id);

async function renderStylist() {
  $('connectCard').hidden = Boolean(await getMeta('stylistPassword'));
  const style = ((await getMeta('style')) || '').trim();
  const insp = (await getMeta('inspiration')) || [];
  let sum = style ? style.slice(0, 120) : 'עוד לא כתבת. ספרי לסטייליסטית מה את אוהבת.';
  if (insp.length) sum += insp.length === 1 ? ' · תמונת השראה אחת' : ` · ${insp.length} תמונות השראה`;
  $('styleSummary').textContent = sum;

  const a = $('anchorChip');
  const anchor = anchorId && itemById(anchorId);
  if (!anchor) anchorId = null;
  a.hidden = !anchor;
  a.textContent = '';
  if (anchor) {
    a.appendChild(el('span', null, `עם: ${anchor.description || catLabel(anchor.category)}`));
    const x = el('button', null, '✕');
    x.setAttribute('aria-label', 'ביטול');
    x.onclick = () => { anchorId = null; renderStylist(); };
    a.appendChild(x);
  }
  renderLook();
  await renderFavorites();
}

function lookItemCard(id, { swappable }) {
  const it = itemById(id);
  const box = el('div', 'look-item' + (it ? '' : ' gone'));
  if (it && it.thumb) {
    const img = el('img'); img.src = it.thumb; img.alt = ''; box.appendChild(img);
    const cap = el('div', 'cap');
    cap.appendChild(el('div', 'cat', catLabel(it.category)));
    if (it.description) { const d = el('div', 'desc', it.description); d.dir = 'auto'; cap.appendChild(d); }
    box.appendChild(cap);
  } else {
    const t = el('div', 'textcard');
    if (it) t.appendChild(el('div', 'cat', catLabel(it.category)));
    const big = el('div', 'big', it ? it.description : 'הפריט נמחק מהארון');
    big.dir = 'auto';
    t.appendChild(big);
    box.appendChild(t);
  }
  if (swappable && it) {
    const b = el('button', 'swap', '🔄 החליפי פריט זה');
    b.onclick = () => askStylist({ swapItemId: id });
    box.appendChild(b);
  }
  return box;
}

function renderLook() {
  const p = $('lookPanel');
  p.textContent = '';
  if (!currentLook) { p.hidden = true; return; }
  p.hidden = false;
  if (!currentLook.ok) {
    p.appendChild(el('h2', null, currentLook.title || 'לא הצלחתי להרכיב לוק'));
    p.appendChild(el('p', 'expl', currentLook.explanation));
    return;
  }
  p.appendChild(el('h2', null, currentLook.title || 'הלוק שלך'));
  const grid = el('div', 'look-items');
  currentLook.itemIds.forEach((id) => grid.appendChild(lookItemCard(id, { swappable: true })));
  p.appendChild(grid);
  if (currentLook.explanation) p.appendChild(el('p', 'expl', currentLook.explanation));
  if (currentLook.tip) p.appendChild(el('p', 'tip', '💡 ' + currentLook.tip));
  const actions = el('div', 'actions');
  const save = el('button', 'wide-btn primary', currentLook.savedId ? '❤️ נשמר' : '❤️ שמירה');
  save.disabled = Boolean(currentLook.savedId);
  save.onclick = saveFavorite;
  const again = el('button', 'wide-btn', 'לוק אחר');
  again.onclick = () => askStylist({ another: true });
  actions.appendChild(save); actions.appendChild(again);
  p.appendChild(actions);
  if (currentLook.costCents != null) p.appendChild(el('p', 'cost', `עלות משוערת של הבקשה: כ-${currentLook.costCents.toFixed(1)} סנט`));
}

async function saveFavorite() {
  if (!currentLook || currentLook.savedId) return;
  const favs = (await getMeta('favorites')) || [];
  const fav = {
    id: newId(), title: currentLook.title, itemIds: currentLook.itemIds.slice(),
    explanation: currentLook.explanation, tip: currentLook.tip, request: currentLook.request,
    savedAt: new Date().toISOString(),
  };
  favs.unshift(fav);
  await setMeta('favorites', favs);
  askPersistentStorage();
  currentLook.savedId = fav.id;
  renderLook();
  await renderFavorites();
  toast('הלוק נשמר באהובים ❤️');
}

async function renderFavorites() {
  const list = $('favList');
  const favs = (await getMeta('favorites')) || [];
  list.textContent = '';
  if (!favs.length) { list.appendChild(el('p', 'muted', 'עוד אין לוקים שמורים. לוק שאהבת — לחצי „שמירה לאהובים”.')); return; }
  favs.forEach((f) => {
    const b = el('button', 'fav');
    const minis = el('div', 'minis');
    f.itemIds.slice(0, 4).forEach((id) => {
      const it = itemById(id);
      if (it && it.thumb) { const im = el('img'); im.src = it.thumb; im.alt = ''; minis.appendChild(im); }
      else minis.appendChild(el('div', 'mini-t'));
    });
    const t = el('div', 't');
    t.appendChild(el('b', null, f.title || 'לוק'));
    t.appendChild(el('small', null, formatDate(f.savedAt)));
    b.appendChild(minis); b.appendChild(t);
    b.onclick = () => openFavorite(f);
    list.appendChild(b);
  });
}

function openFavorite(f) {
  const body = $('lookSheetBody');
  body.textContent = '';
  body.classList.add('look');
  $('lookSheetTitle').textContent = f.title || 'לוק אהוב';
  const grid = el('div', 'look-items');
  f.itemIds.forEach((id) => grid.appendChild(lookItemCard(id, { swappable: false })));
  body.appendChild(grid);
  if (f.explanation) body.appendChild(el('p', 'expl', f.explanation));
  if (f.tip) body.appendChild(el('p', 'tip', '💡 ' + f.tip));
  if (f.request) body.appendChild(el('p', 'muted', `הבקשה: ${f.request}`));
  const del = el('button', 'wide-btn danger', 'מחיקה מהאהובים');
  del.onclick = async () => {
    if (!confirm('למחוק את הלוק מהאהובים?')) return;
    const favs = ((await getMeta('favorites')) || []).filter((x) => x.id !== f.id);
    await setMeta('favorites', favs);
    if (currentLook && currentLook.savedId === f.id) currentLook.savedId = null;
    closeSheet('lookSheet');
    await renderStylist();
    toast('הלוק נמחק מהאהובים');
  };
  body.appendChild(del);
  openSheet('lookSheet');
}

async function aiImage(it) {
  if (!it.thumb) return null;
  const key = it.id + '|' + (it.updatedAt || '');
  if (aiImageCache.has(key)) return aiImageCache.get(key);
  const img = new Image();
  img.src = it.thumb;
  await img.decode();
  const small = resizeToDataURL(img, AI_IMAGE_MAX, 0.75);
  aiImageCache.set(key, small);
  return small;
}

function estimateCents(u) {
  // Opus-tier list prices, USD per million tokens: input 4, output 20, cache write 5, cache read 0.2.
  if (!u) return null;
  const usd = (u.input_tokens * 4 + u.output_tokens * 20 + u.cache_creation_input_tokens * 5 + u.cache_read_input_tokens * 0.2) / 1e6;
  return usd * 100;
}

async function askStylist({ swapItemId = null, another = false } = {}) {
  const pw = await getMeta('stylistPassword');
  const errBox = $('askError');
  errBox.hidden = true;
  if (!pw) { errBox.textContent = 'קודם צריך לחבר את הסטייליסטית עם הסיסמה (למעלה).'; errBox.hidden = false; return; }
  if (items.length === 0) { errBox.textContent = 'הארון ריק. הוסיפי כמה בגדים קודם.'; errBox.hidden = false; return; }

  let request = $('requestInput').value.trim();
  let anchor = anchorId;
  let excluded = [];
  if ((swapItemId || another) && currentLook) {
    request = currentLook.request;
    anchor = currentLook.anchorId;
    excluded = (currentLook.excluded || []).slice();
    if (swapItemId) excluded.push(swapItemId);
  }
  if (another && currentLook) request = `${request || 'לוק'} — הפעם לוק שונה מהקודם (${currentLook.itemIds.join(', ')}).`;

  $('askBtn').disabled = true;
  $('thinking').hidden = false;
  if (!swapItemId) { currentLook = null; renderLook(); }
  document.querySelectorAll('.look-item .swap').forEach((b) => { b.disabled = true; });
  $('thinking').scrollIntoView({ behavior: 'smooth', block: 'center' });

  try {
    const payloadItems = [];
    for (const it of items) {
      payloadItems.push({ id: it.id, category: catLabel(it.category), description: it.description || '', image: await aiImage(it) });
    }
    const insp = (await getMeta('inspiration')) || [];
    const inspiration = [];
    for (const src of insp) {
      const img = new Image(); img.src = src; await img.decode();
      inspiration.push(resizeToDataURL(img, 512, 0.75));
    }
    const body = {
      mode: swapItemId ? 'swap' : 'new',
      request, anchorItemId: anchor, items: payloadItems, inspiration,
      style: (await getMeta('style')) || '',
      today: new Date().toLocaleDateString('he-IL', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
      look: swapItemId ? currentLook.itemIds : undefined,
      swapItemId: swapItemId || undefined,
      excluded,
    };
    const res = await fetch(STYLIST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-App-Password': pw },
      body: JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch (_) { /* handled below */ }
    if (!res.ok) {
      if (res.status === 401) { await setMeta('stylistPassword', ''); $('connectCard').hidden = false; }
      throw new Error((data && data.message) || 'הסטייליסטית לא זמינה כרגע. נסי שוב.');
    }
    currentLook = {
      ok: data.ok, title: data.title, itemIds: data.item_ids || [], explanation: data.explanation, tip: data.tip,
      request, anchorId: anchor, excluded, savedId: null, costCents: estimateCents(data.usage),
    };
  } catch (err) {
    const offline = err instanceof TypeError;
    errBox.textContent = offline ? 'אין חיבור לסטייליסטית. בדקי שיש אינטרנט ונסי שוב.' : err.message;
    errBox.hidden = false;
  } finally {
    $('askBtn').disabled = false;
    $('thinking').hidden = true;
    renderLook();
    if (currentLook) $('lookPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

async function savePassword() {
  const v = $('pwInput').value.trim();
  if (!v) return;
  await setMeta('stylistPassword', v);
  $('pwInput').value = '';
  await renderStylist();
  toast('הסטייליסטית מחוברת');
}

/* ---------- My style sheet ---------- */

let inspDraft = [];

async function openStyle() {
  $('styleInput').value = (await getMeta('style')) || '';
  inspDraft = ((await getMeta('inspiration')) || []).slice();
  renderInsp();
  openSheet('styleSheet');
}

function renderInsp() {
  const g = $('inspGrid');
  g.textContent = '';
  inspDraft.forEach((src, i) => {
    const d = el('div', 'insp');
    const im = el('img'); im.src = src; im.alt = ''; d.appendChild(im);
    const x = el('button', null, '✕');
    x.setAttribute('aria-label', 'הסרה');
    x.onclick = () => { inspDraft.splice(i, 1); renderInsp(); };
    d.appendChild(x);
    g.appendChild(d);
  });
  if (inspDraft.length < MAX_INSPIRATION) {
    const add = el('button', 'insp-add', '+');
    add.setAttribute('aria-label', 'הוספת תמונת השראה');
    add.onclick = () => $('inspInput').click();
    g.appendChild(add);
  }
}

async function onInspChosen(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const { img, url } = await loadImage(file);
    inspDraft.push(resizeToDataURL(img, INSP_MAX, 0.82));
    URL.revokeObjectURL(url);
    renderInsp();
  } catch (_) { toast('לא הצלחתי לטעון את התמונה'); }
}

async function saveStyle() {
  await setMeta('style', $('styleInput').value.trim().slice(0, 6000));
  await setMeta('inspiration', inspDraft.slice(0, MAX_INSPIRATION));
  askPersistentStorage();
  closeSheet('styleSheet');
  await renderStylist();
  toast('הסגנון נשמר');
}

/* ---------- Install hint ---------- */

async function maybeShowBanner() {
  if (!isIOS() || isStandalone()) return;
  if (await getMeta('bannerDismissed')) return;
  const b = $('banner');
  b.textContent = '';
  b.appendChild(el('b', null, 'טיפ: '));
  b.appendChild(document.createTextNode('הוסיפי את האפליקציה למסך הבית — לחצי על כפתור השיתוף ⬆️ ואז „הוספה למסך הבית”. כך הארון נשמר בצורה בטוחה יותר.'));
  const x = el('button', null, '✕');
  x.setAttribute('aria-label', 'סגירה');
  x.onclick = () => { b.hidden = true; setMeta('bannerDismissed', true); };
  b.appendChild(x);
  b.hidden = false;
}

/* ---------- Wire up ---------- */

function init() {
  $('addBtn').onclick = () => openItem(null);
  $('settingsBtn').onclick = openSettings;
  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.onclick = () => closeSheet(btn.closest('.sheet').id);
  });
  $('photoBox').onclick = () => $('photoInput').click();
  $('changePhotoBtn').onclick = () => $('photoInput').click();
  $('removePhotoBtn').onclick = () => { draft.photo = null; draft.thumb = null; renderPhoto(); };
  $('photoInput').onchange = onPhotoChosen;
  $('saveBtn').onclick = saveItem;
  $('deleteBtn').onclick = removeItem;
  $('backupBtn').onclick = backup;
  $('restoreBtn').onclick = () => $('restoreInput').click();
  $('restoreInput').onchange = onRestoreChosen;
  $('search').oninput = (e) => { query = e.target.value; render(); };

  // Stylist
  $('tabCloset').onclick = () => setTab('closet');
  $('tabStylist').onclick = () => setTab('stylist');
  $('askBtn').onclick = () => askStylist();
  $('pwSaveBtn').onclick = savePassword;
  $('styleBtn').onclick = openStyle;
  $('styleSaveBtn').onclick = saveStyle;
  $('inspInput').onchange = onInspChosen;
  $('anchorBtn').onclick = () => {
    if (!editing) return;
    anchorId = editing.id;
    closeSheet('itemSheet');
    setTab('stylist');
  };
  $('pwResetBtn').onclick = async () => {
    await setMeta('stylistPassword', '');
    closeSheet('settingsSheet');
    setTab('stylist');
    $('pwInput').focus();
  };
  const quick = $('quickChips');
  QUICK_REQUESTS.forEach((q) => {
    const c = el('button', 'chip', q);
    c.type = 'button';
    c.onclick = () => { $('requestInput').value = q; };
    quick.appendChild(c);
  });

  refresh().catch(() => {
    $('empty').hidden = true;
    $('grid').textContent = '';
    $('grid').appendChild(el('p', 'error', 'לא הצלחתי לפתוח את הארון בדפדפן הזה. נסי לפתוח ב-Safari רגיל (לא בגלישה פרטית).'));
  });
  maybeShowBanner();
}

init();
