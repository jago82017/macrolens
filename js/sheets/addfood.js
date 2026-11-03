// The Add Food sheet: Search · Scan · Snap (AI) · Create · Quick add.

import { openSheet, toast, skeletonRows } from '../ui.js';
import { icon } from '../icons.js';
import { esc, fmt, round, MEALS, mealName, mealForNow, todayKey, relDay, debounce, haptic } from '../util.js';
import { allFoods, recentFoods, addEntry, addEntries, touchFood } from '../store.js';
import { BUILTIN_FOODS, searchBuiltin } from '../fooddb.js';
import { searchOFF, searchUSDA, lookupBarcode } from '../api.js';
import { startScanner, warmScanner } from '../scanner.js';
import { analyzeMeal, computeNutrients, isModelCached, PREPS, MODEL_SIZE_MB } from '../ai.js';
import { openFoodDetail, foodRow, thumb, badge, foodForm, quickFields, readQuick } from './food.js';
import { checkGoals } from '../celebrate.js';

const TABS = [
  { id: 'search', label: 'Search', icon: 'search' },
  { id: 'scan', label: 'Scan', icon: 'scan' },
  { id: 'snap', label: 'Snap AI', icon: 'sparkles' },
  { id: 'create', label: 'Create', icon: 'edit' },
  { id: 'quick', label: 'Quick', icon: 'zap' },
];

export function openAddFood({ date = todayKey(), meal = mealForNow(), tab = 'search', ...opts } = {}) {
  const ctx = { date, meal, added: 0, cleanup: null, mealListeners: new Set() };
  const sheet = openSheet({
    full: true,
    className: 'add-sheet',
    html: `
      <div class="sheet-head add-head">
        <button class="btn-icon ghost" data-close aria-label="Close">${icon('x')}</button>
        <div class="add-title"><h2>Add food</h2><p class="muted small">${esc(relDay(date))}</p></div>
        <button class="btn sm primary add-done" data-close hidden>Done</button>
      </div>
      <div class="meal-chips add-meals">${MEALS.map(m => `<button class="chip ${m.id === meal ? 'active' : ''}" data-meal="${m.id}">${m.emoji} ${m.name}</button>`).join('')}</div>
      <nav class="add-tabs" role="tablist">${TABS.map(t => `<button role="tab" data-tab="${t.id}">${icon(t.icon, 18)}<span>${t.label}</span></button>`).join('')}<span class="tab-ink"></span></nav>
      <div class="add-pane"></div>`,
    onClose: () => ctx.cleanup?.(),
  });
  const pane = sheet.el.querySelector('.add-pane');
  const doneBtn = sheet.el.querySelector('.add-done');

  ctx.sheet = sheet;
  ctx.onAdded = (name, kcal) => {
    ctx.added++;
    doneBtn.hidden = false;
    doneBtn.textContent = `Done · ${ctx.added}`;
    toast(`Added ${name} · ${fmt(kcal)} kcal`, { icon: 'check', duration: 2200 });
  };
  ctx.switchTab = (id, o = {}) => {
    ctx.cleanup?.();
    ctx.cleanup = null;
    ctx.mealListeners.clear();
    const tabs = [...sheet.el.querySelectorAll('[data-tab]')];
    tabs.forEach(b => b.classList.toggle('active', b.dataset.tab === id));
    const active = tabs.find(b => b.dataset.tab === id);
    const ink = sheet.el.querySelector('.tab-ink');
    ink.style.transform = `translateX(${active.offsetLeft}px)`;
    ink.style.width = `${active.offsetWidth}px`;
    pane.scrollTop = 0;
    pane.innerHTML = '';
    pane.dataset.tab = id;
    ctx.cleanup = PANES[id](pane, ctx, o) || null;
  };

  sheet.el.addEventListener('click', e => {
    const tab = e.target.closest('.add-tabs [data-tab]');
    if (tab) { ctx.switchTab(tab.dataset.tab); return; }
    const m = e.target.closest('.add-meals [data-meal]');
    if (m) {
      ctx.meal = m.dataset.meal;
      sheet.el.querySelectorAll('.add-meals [data-meal]').forEach(b => b.classList.toggle('active', b === m));
      ctx.mealListeners.forEach(fn => fn(ctx.meal));
      haptic(5);
    }
  });

  requestAnimationFrame(() => ctx.switchTab(tab, opts));
  return sheet;
}

const detailOpts = ctx => ({
  date: ctx.date,
  meal: ctx.meal,
  onAdded: data => ctx.onAdded(data.name, data.kcal),
});

// ---------------- Search ----------------
function scoreLocal(f, terms) {
  const n = `${f.name} ${f.brand || ''}`.toLowerCase();
  if (!terms.every(t => n.includes(t))) return -1;
  return (n.startsWith(terms[0]) ? 3 : 1) + (f.uses || 0) * 0.2 + (f.favorite ? 2 : 0) + (f.source === 'custom' ? 1 : 0);
}

function searchPane(pane, ctx, { query = '', pick } = {}) {
  pane.innerHTML = `
    <div class="search-box sticky">${icon('search', 18)}
      <input type="search" placeholder="Search foods, brands, dishes…" enterkeyhint="search" autocomplete="off" value="${esc(query)}">
      <button class="btn-icon ghost sm clear" hidden aria-label="Clear">${icon('x', 16)}</button>
    </div>
    <div class="results"></div>`;
  const input = pane.querySelector('input');
  const clearBtn = pane.querySelector('.clear');
  const results = pane.querySelector('.results');
  const byId = new Map();
  let ctrl = null, seq = 0, shownIds = new Set();
  const reg = list => { list.forEach(f => byId.set(f.id, f)); return list; };
  const section = (title, list, extra = '') => list.length ? `<section class="res-sec"><h4>${title}${extra}</h4><div class="list">${list.map(foodRow).join('')}</div></section>` : '';

  results.addEventListener('click', e => {
    const row = e.target.closest('[data-fid]');
    if (row) {
      const food = byId.get(row.dataset.fid);
      if (!food) return;
      if (pick) pick(food);
      else openFoodDetail(food, detailOpts(ctx));
      return;
    }
    const c = e.target.closest('[data-create]');
    if (c) ctx.switchTab?.('create', { name: input.value.trim() });
  });

  async function showDefault() {
    const [recent, all] = await Promise.all([recentFoods(12), allFoods()]);
    const favs = all.filter(f => f.favorite).slice(0, 12);
    const mine = all.filter(f => f.source === 'custom').sort((a, b) => (b.lastUsed || b.createdAt) - (a.lastUsed || a.createdAt)).slice(0, 12);
    const popular = ['banana', 'chicken', 'rice', 'greekyogurt', 'boiledegg', 'oatmeal', 'avocado', 'salmon'].map(k => BUILTIN_FOODS.find(f => f.key === k));
    reg([...favs, ...recent, ...mine, ...popular]);
    results.innerHTML =
      section(`${icon('star', 14)} Favourites`, favs) +
      section(`${icon('refresh', 14)} Recent`, recent) +
      section(`${icon('edit', 14)} My foods`, mine) +
      section(`${icon('leaf', 14)} Popular basics`, popular) +
      (pick ? '' : createCta(''));
  }

  async function run(q) {
    const my = ++seq;
    ctrl?.abort();
    ctrl = null;
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const stored = (await allFoods()).map(f => ({ f, s: scoreLocal(f, terms) })).filter(x => x.s >= 0).sort((a, b) => b.s - a.s).map(x => x.f);
    const storedIds = new Set(stored.map(f => f.id));
    const local = [...stored, ...searchBuiltin(q).filter(f => !storedIds.has(f.id))].slice(0, 20);
    if (my !== seq) return;
    reg(local);
    shownIds = new Set(local.map(f => f.id));
    const online = q.length >= 3;
    results.innerHTML =
      section(`${icon('database', 14)} On this device`, local) +
      (online ? `<section class="res-sec" data-sec="off"><h4>${icon('scan', 14)} Open Food Facts</h4><div class="list">${skeletonRows(3)}</div></section>
                 <section class="res-sec" data-sec="usda"><h4>${icon('leaf', 14)} USDA generic foods</h4><div class="list">${skeletonRows(3)}</div></section>` : '') +
      (!local.length && !online ? `<p class="empty">Keep typing to search online databases…</p>` : '') +
      (pick ? '' : createCta(q));
    if (online) onlineSearch(q, my);
  }

  const onlineSearch = debounce(async (q, my) => {
    if (my !== seq) return;
    ctrl = new AbortController();
    const signal = ctrl.signal;
    const fill = async (key, fn) => {
      const sec = results.querySelector(`[data-sec="${key}"]`);
      try {
        const list = (await fn(q, signal)).filter(f => !shownIds.has(f.id)).slice(0, 15);
        if (my !== seq || !sec) return;
        reg(list);
        sec.querySelector('.list').innerHTML = list.length ? list.map(foodRow).join('') : `<p class="empty sm">No results</p>`;
      } catch (e) {
        if (e.name === 'AbortError' || !sec) return;
        sec.querySelector('.list').innerHTML = `<p class="empty sm warn-text">${esc(navigator.onLine ? e.message : 'Offline — showing on-device results only')}</p>`;
      }
    };
    fill('off', searchOFF);
    fill('usda', searchUSDA);
  }, 450);

  const onInput = () => {
    const q = input.value.trim();
    clearBtn.hidden = !q;
    if (q) run(q); else { seq++; ctrl?.abort(); showDefault(); }
  };
  input.addEventListener('input', onInput);
  clearBtn.addEventListener('click', () => { input.value = ''; onInput(); input.focus(); });
  onInput();
  if (!query) setTimeout(() => input.focus({ preventScroll: true }), 350);
  return () => { seq++; ctrl?.abort(); };
}

const createCta = q => `
  <button class="cta-card" data-create>
    <span class="cta-ico">${icon('plus', 20)}</span>
    <span><b>${q ? `Create “${esc(q)}”` : 'Create a custom food'}</b><small>Can't find it? Add it from the label in seconds.</small></span>
    ${icon('chevR', 18)}
  </button>`;

// Stand-alone search sheet used by the AI flow to correct a guess.
export function openFoodPicker({ query = '', title = 'Pick the right food', onPick }) {
  const sheet = openSheet({ title, html: '<div class="add-pane picker-pane"></div>', full: true, className: 'add-sheet picker' });
  const cleanup = searchPane(sheet.el.querySelector('.picker-pane'), {}, { query, pick: f => { sheet.close(); onPick(f); } });
  const prev = sheet.onClose;
  sheet.onClose = v => { cleanup?.(); prev?.(v); };
  return sheet;
}

// ---------------- Scan ----------------
function scanPane(pane, ctx, { barcode } = {}) {
  pane.innerHTML = `
    <div class="scanner">
      <video muted playsinline></video>
      <div class="scan-overlay"><div class="scan-frame"><i></i><i></i><i></i><i></i><span class="laser"></span></div></div>
      <div class="scan-msg">${icon('camera', 16)} Starting camera…</div>
      <button class="btn-icon scan-torch" hidden aria-label="Toggle torch">${icon('zap')}</button>
    </div>
    <form class="manual-code">
      <div class="search-box">${icon('keyboard', 18)}<input name="code" inputmode="numeric" pattern="[0-9]*" placeholder="Or type the barcode number" autocomplete="off"></div>
      <button class="btn primary" type="submit">Look up</button>
    </form>
    <div class="scan-result"></div>
    <p class="muted small center">Searches Open Food Facts first, then USDA branded foods. Not found? Create it once and it scans instantly next time.</p>`;
  const video = pane.querySelector('video');
  const msg = pane.querySelector('.scan-msg');
  const torchBtn = pane.querySelector('.scan-torch');
  const result = pane.querySelector('.scan-result');
  const scannerEl = pane.querySelector('.scanner');
  let scanner = null, stopped = false, ctrl = null;

  warmScanner();
  startScanner(video, { onCode: code => { haptic([20, 40, 20]); scannerEl.classList.add('hit'); setTimeout(() => scannerEl.classList.remove('hit'), 500); lookup(code); } })
    .then(s => {
      if (stopped) { s.stop(); return; }
      scanner = s;
      msg.innerHTML = `${icon('scan', 16)} Align the barcode inside the frame`;
      scannerEl.classList.add('live');
      if (s.hasTorch) torchBtn.hidden = false;
    })
    .catch(err => {
      scannerEl.classList.add('no-cam');
      const denied = /denied|NotAllowed/i.test(`${err.name} ${err.message}`);
      msg.innerHTML = `${icon('info', 16)} ${denied ? 'Camera permission denied — enable it in site settings, or type the code below.' : esc(err.message || 'Camera unavailable')}`;
    });

  torchBtn.addEventListener('click', async () => {
    try { torchBtn.classList.toggle('on', await scanner.toggleTorch()); } catch { toast('Torch not supported'); }
  });

  pane.querySelector('.manual-code').addEventListener('submit', e => {
    e.preventDefault();
    const code = e.target.elements.code.value.replace(/\D/g, '');
    if (code.length < 6) { toast('Enter at least 6 digits', { icon: 'info' }); return; }
    e.target.elements.code.blur();
    lookup(code);
  });

  const resume = () => { result.innerHTML = ''; scanner?.resume(); };

  async function lookup(code) {
    scanner?.pause();
    ctrl?.abort();
    ctrl = new AbortController();
    result.innerHTML = `
      <div class="card scan-status">
        <div class="spinner"></div>
        <div><b>Looking up ${esc(code)}</b>
          <div class="steps-inline"><span data-s="off">Open Food Facts</span><span data-s="usda">USDA</span></div>
        </div>
      </div>`;
    try {
      const r = await lookupBarcode(code, {
        signal: ctrl.signal,
        onStatus: s => {
          result.querySelectorAll('[data-s]').forEach(el => {
            if (el.dataset.s === s) el.classList.add('active');
            else if (el.classList.contains('active')) { el.classList.remove('active'); el.classList.add('done'); }
          });
        },
      });
      if (stopped) return;
      if (r) {
        result.innerHTML = `
          <div class="card scan-found">
            <div class="li-thumb">${thumb(r.food)}</div>
            <div class="li-main"><div class="li-title">${esc(r.food.name)}</div><div class="li-sub">${badge(r.food.source)} ${esc(r.food.brand || '')} · found in ${esc(r.from)}</div></div>
            <button class="btn primary sm" data-open>Add</button>
          </div>`;
        const open = () => openFoodDetail(r.food, { ...detailOpts(ctx), onClose: () => setTimeout(resume, 250) });
        result.querySelector('[data-open]').onclick = open;
        open();
      } else {
        result.innerHTML = `
          <div class="card scan-missing">
            <div class="missing-ico">🔎</div>
            <b>No product found for ${esc(code)}</b>
            <p class="muted small">It isn't in Open Food Facts or USDA yet. Add it once from the label — it'll be recognised instantly next time.</p>
            <div class="row gap">
              <button class="btn ghost" data-again>${icon('scan', 18)} Scan again</button>
              <button class="btn primary grow" data-create>${icon('plus', 18)} Create food</button>
            </div>
          </div>`;
        result.querySelector('[data-again]').onclick = resume;
        result.querySelector('[data-create]').onclick = () => ctx.switchTab('create', { barcode: code });
      }
    } catch (e) {
      if (e.name === 'AbortError') return;
      result.innerHTML = `
        <div class="card scan-missing">
          <div class="missing-ico">📡</div>
          <b>Lookup failed</b><p class="muted small">${esc(e.message)}</p>
          <div class="row gap"><button class="btn ghost" data-again>Scan again</button><button class="btn primary grow" data-create>Create food</button></div>
        </div>`;
      result.querySelector('[data-again]').onclick = resume;
      result.querySelector('[data-create]').onclick = () => ctx.switchTab('create', { barcode: code });
    }
  }

  if (barcode) lookup(barcode);
  return () => { stopped = true; ctrl?.abort(); scanner?.stop(); };
}

// ---------------- Snap (on-device AI) ----------------
const STEPS = [
  ['model', 'Loading on-device model'],
  ['vocab', 'Learning food vocabulary'],
  ['vision', 'Reading photo · 4 augmented views'],
  ['identify', 'Identifying food & checking your history'],
  ['portion', 'Estimating portion, cooking & calorie density'],
];
const CONF = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence — check it' };

function snapPane(pane, ctx) {
  let alive = true;
  let photoUrl = null;
  let analysis = null;
  let items = []; // { food, est, grams, prep, picked }

  const revoke = () => { if (photoUrl) URL.revokeObjectURL(photoUrl); photoUrl = null; };

  async function intro() {
    revoke();
    const cached = await isModelCached('vision');
    if (!alive) return;
    pane.innerHTML = `
      <div class="snap-intro">
        <div class="snap-hero">
          <div class="snap-orb">${icon('sparkles', 34)}</div>
          <h3>Snap your meal</h3>
          <p class="muted">A small AI model runs entirely on your phone. It recognises the food, then real nutrition data is injected for the macros. Your photos never leave the device.</p>
        </div>
        <label class="btn primary block lg">${icon('camera')} Take photo<input type="file" accept="image/*" capture="environment" hidden data-file></label>
        <label class="btn ghost block">${icon('image')} Choose from gallery<input type="file" accept="image/*" hidden data-file></label>
        <div class="field">
          <label class="label">Hint <span class="muted">(optional — boosts accuracy)</span></label>
          <input class="input" data-hint placeholder="e.g. chicken curry, about 350 g" autocomplete="off">
        </div>
        <div class="model-status ${cached ? 'ok' : ''}">${icon(cached ? 'shield' : 'cpu', 16)}<span>MobileCLIP-S0 · ${cached ? 'downloaded — works offline' : `${MODEL_SIZE_MB.vision} MB one-time download on first use`}</span></div>
        <ul class="tips">
          <li>${icon('bulb', 14)} Shoot from above in good light, one plate per photo.</li>
          <li>${icon('bulb', 14)} Mixed plates? Tap extra detected items to add them.</li>
          <li>${icon('bulb', 14)} Every confirmed photo teaches the model your regular meals.</li>
        </ul>
      </div>`;
    pane.querySelectorAll('[data-file]').forEach(inp => inp.addEventListener('change', () => {
      const f = inp.files?.[0];
      if (f) run(f, pane.querySelector('[data-hint]').value);
    }));
  }

  async function run(file, hint) {
    revoke();
    photoUrl = URL.createObjectURL(file);
    pane.innerHTML = `
      <div class="snap-analyzing">
        <div class="snap-photo"><img src="${photoUrl}" alt=""><div class="scanline"></div><div class="snap-grid"></div></div>
        <ol class="steps">${STEPS.map(([k, l]) => `<li data-step="${k}"><span class="st-ico"></span><span class="st-label">${l}</span><span class="st-pct"></span></li>`).join('')}</ol>
      </div>`;
    const order = STEPS.map(s => s[0]);
    const onStep = (step, p) => {
      if (!alive) return;
      const i = order.indexOf(step === 'done' ? 'zzz' : step);
      pane.querySelectorAll('[data-step]').forEach((li, k) => {
        li.classList.toggle('done', step === 'done' || (i >= 0 && k < i));
        li.classList.toggle('active', k === i);
      });
      const li = pane.querySelector(`[data-step="${step}"]`);
      if (li && typeof p === 'number') li.querySelector('.st-pct').textContent = p < 1 ? `${Math.round(p * 100)}%` : '';
    };
    try {
      analysis = await analyzeMeal(file, { hint, onStep });
      if (!alive) return;
      const primary = analysis.candidates[0];
      items = [{ food: primary.food, est: analysis.cache.get(primary.food.id), prep: 'auto', p: primary.p }];
      items[0].grams = items[0].est.grams;
      haptic(20);
      results();
    } catch (e) {
      console.error(e);
      if (!alive) return;
      pane.innerHTML = `
        <div class="card scan-missing">
          <div class="missing-ico">🤖</div>
          <b>Couldn't analyse the photo</b>
          <p class="muted small">${esc(e.message)}${!navigator.onLine ? ' — the model needs one online download before it works offline.' : ''}</p>
          <button class="btn primary block" data-retry>Try again</button>
        </div>`;
      pane.querySelector('[data-retry]').onclick = intro;
    }
  }

  function itemNutrients(it) { return computeNutrients(it.food, it.grams, it.est, it.prep); }

  function results() {
    const a = analysis;
    const primary = items[0]?.food || a.candidates[0].food;
    const selected = new Set(items.map(i => i.food.id));
    const memo = a.memoryMatch ? `<span class="pill">${icon('refresh', 12)} Matched your past meals</span>` : '';
    pane.innerHTML = `
      <div class="snap-results">
        <div class="snap-top">
          <img class="snap-thumb" src="${photoUrl}" alt="">
          <div>
            <span class="conf conf-${a.confidence}">${CONF[a.confidence]}</span>
            <h3>${esc(primary.name)}</h3>
            <div class="row gap-sm wrap">${memo}${a.hint ? `<span class="pill">${icon('bulb', 12)} Hint applied</span>` : ''}</div>
          </div>
        </div>
        <div class="cand-label">Detected on the plate — tap to add or remove</div>
        <div class="cands">
          ${a.candidates.map(c => `<button class="cand ${selected.has(c.food.id) ? 'on' : ''}" data-cid="${esc(c.food.id)}"><span>${c.food.emoji || '🍽️'}</span>${esc(c.food.name)}<b>${Math.max(1, Math.round(c.p * 100))}%</b></button>`).join('')}
          ${items.filter(i => i.picked).map(i => `<button class="cand on" data-cid="${esc(i.food.id)}"><span>${i.food.emoji || '✅'}</span>${esc(i.food.name)}<b>you</b></button>`).join('')}
        </div>
        <div class="ai-items">${items.map((it, k) => itemCard(it, k)).join('') || '<p class="empty">Select at least one item above.</p>'}</div>
        <div class="card snap-total"></div>
        <div class="snap-actions">
          <button class="btn ghost" data-act="search">${icon('search', 18)} Not right? Search</button>
          <button class="btn ghost" data-act="retake">${icon('camera', 18)} New photo</button>
        </div>
        <div class="pane-foot"><button class="btn primary block lg" data-act="add"></button></div>
      </div>`;
    totals();
  }

  function itemCard(it, k) {
    const src = {
      hint: 'Weight from your hint',
      memory: 'Portion learned from your history',
      portion: `Portion estimated · ${it.est.mult.toFixed(2)}× a typical serving`,
      serving: 'Typical serving — adjust if needed',
    }[it.est.gramsSource];
    const max = Math.max(600, Math.round(it.grams * 2.5 / 50) * 50);
    const prep = it.est.prep;
    return `
      <div class="ai-item" data-k="${k}">
        <div class="ai-item-head">
          <span class="ai-emoji">${it.food.emoji || '🍽️'}</span>
          <div class="grow"><b>${esc(it.food.name)}</b><small class="muted">${src}</small></div>
          <button class="btn-icon ghost sm" data-rm="${k}" aria-label="Remove">${icon('x', 16)}</button>
        </div>
        <div class="grams-row">
          <input type="range" min="5" max="${max}" step="5" value="${it.grams}" data-range="${k}">
          <label class="grams-val"><input type="number" inputmode="numeric" value="${it.grams}" data-grams="${k}"><span>g</span></label>
        </div>
        ${prep ? `
          <div class="prep-row">
            <span class="muted small">Cooking</span>
            <select class="input sm" data-prep="${k}">
              <option value="auto" ${it.prep === 'auto' ? 'selected' : ''}>Auto · looks ${esc(prep.label.toLowerCase())} (${Math.round(prep.p * 100)}%)</option>
              ${PREPS.map(p => `<option value="${p.id}" ${it.prep === p.id ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}
            </select>
          </div>` : ''}
        ${Math.abs(it.est.density - 1) > 0.02 ? `<div class="muted small density">${icon('flame', 12)} Calorie density check: ${it.est.density > 1 ? 'looks richer' : 'looks lighter'} than typical (${it.est.density > 1 ? '+' : ''}${Math.round((it.est.density - 1) * 100)}%)</div>` : ''}
        <div class="ai-macros" data-m="${k}"></div>
      </div>`;
  }

  function totals() {
    let t = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
    items.forEach((it, k) => {
      const n = itemNutrients(it);
      const el = pane.querySelector(`[data-m="${k}"]`);
      if (el) el.innerHTML = `<span><b>${fmt(n.kcal)}</b> kcal</span><span class="protein-text">P ${fmt(n.protein, 1)}g</span><span class="carbs-text">C ${fmt(n.carbs, 1)}g</span><span class="fat-text">F ${fmt(n.fat, 1)}g</span>`;
      t = { kcal: t.kcal + n.kcal, protein: t.protein + n.protein, carbs: t.carbs + n.carbs, fat: t.fat + n.fat };
    });
    const tot = pane.querySelector('.snap-total');
    if (tot) tot.innerHTML = `
      <div class="snap-total-kcal"><b>${fmt(t.kcal)}</b><span>kcal total</span></div>
      <div class="snap-total-macros">
        <span class="protein-text"><b>${fmt(t.protein)}g</b> protein</span>
        <span class="carbs-text"><b>${fmt(t.carbs)}g</b> carbs</span>
        <span class="fat-text"><b>${fmt(t.fat)}g</b> fat</span>
      </div>`;
    const add = pane.querySelector('[data-act="add"]');
    if (add) {
      add.disabled = !items.length;
      add.textContent = items.length ? `Add ${items.length} item${items.length > 1 ? 's' : ''} to ${mealName(ctx.meal)}` : 'Select an item';
    }
  }

  async function addItem(food, { picked = false } = {}) {
    const est = await analysis.estimate(food);
    items.push({ food, est, grams: est.grams, prep: 'auto', picked });
    results();
  }

  pane.addEventListener('click', async e => {
    const t = e.target.closest('button');
    if (!t || !analysis) return;
    if (t.dataset.cid) {
      const id = t.dataset.cid;
      const idx = items.findIndex(i => i.food.id === id);
      if (idx >= 0) { items.splice(idx, 1); results(); }
      else {
        const c = analysis.candidates.find(c => c.food.id === id);
        if (c) { t.classList.add('loading'); await addItem(c.food); }
      }
      haptic(8);
    } else if (t.dataset.rm) {
      items.splice(+t.dataset.rm, 1);
      results();
    } else if (t.dataset.act === 'retake') {
      intro();
    } else if (t.dataset.act === 'search') {
      openFoodPicker({ query: analysis.hint || '', onPick: food => addItem(food, { picked: true }) });
    } else if (t.dataset.act === 'add') {
      if (!items.length) return;
      t.disabled = true;
      const entries = items.map(it => {
        const n = itemNutrients(it);
        const g = it.grams;
        const per100 = Object.fromEntries(Object.entries(n).map(([k, v]) => [k, round((v / g) * 100, 2)]));
        return {
          date: ctx.date, meal: ctx.meal, foodId: it.food.id, name: it.food.name, brand: it.food.brand || '',
          emoji: it.food.emoji || '🍽️', image: analysis.thumb, source: 'ai', per100, grams: g, qty: g, unit: 'g', unitGrams: 1,
          kcal: round(n.kcal, 1), protein: round(n.protein, 1), carbs: round(n.carbs, 1), fat: round(n.fat, 1),
          fiber: n.fiber != null ? round(n.fiber, 1) : undefined,
          ai: { confidence: analysis.confidence, p: round(it.p ?? 0, 3), prep: it.prep },
        };
      });
      await addEntries(entries);
      await analysis.remember(items.map(it => ({ food: it.food, grams: it.grams })));
      for (const it of items) if (it.food.source !== 'ai') await touchFood(it.food).catch(() => {});
      const kcal = entries.reduce((s, x) => s + x.kcal, 0);
      ctx.onAdded(entries.length > 1 ? `${entries.length} items` : entries[0].name, kcal);
      checkGoals(ctx.date);
      intro();
    }
  });

  pane.addEventListener('input', e => {
    const t = e.target;
    const k = +(t.dataset.range ?? t.dataset.grams ?? -1);
    if (k < 0 || !items[k]) return;
    const g = Math.max(1, Math.round(+t.value || 0));
    items[k].grams = g;
    const card = pane.querySelector(`.ai-item[data-k="${k}"]`);
    if (t.dataset.range != null) card.querySelector('[data-grams]').value = g;
    else card.querySelector('[data-range]').value = g;
    totals();
  });
  pane.addEventListener('change', e => {
    const k = e.target.dataset.prep;
    if (k == null) return;
    items[+k].prep = e.target.value;
    totals();
  });

  ctx.mealListeners.add(() => totals());
  intro();
  return () => { alive = false; revoke(); };
}

// ---------------- Create ----------------
function createPane(pane, ctx, { barcode = '', name = '' } = {}) {
  pane.innerHTML = `
    <div class="pane-intro">${icon('edit', 18)}<div><b>Create a custom food</b><p class="muted small">Copy the values from the nutrition label. Saved foods appear in search and barcode scans${barcode ? ` — barcode <b>${esc(barcode)}</b> attached` : ''}.</p></div></div>
    <div class="form-host"></div>`;
  foodForm(pane.querySelector('.form-host'), {
    barcode, name,
    submitLabel: 'Save & continue',
    onSave: food => {
      toast(`${food.name} saved to My foods`, { icon: 'check' });
      openFoodDetail(food, { ...detailOpts(ctx), onClose: v => { if (v === 'added') ctx.switchTab('search'); } });
    },
  });
}

// ---------------- Quick add ----------------
function quickPane(pane, ctx) {
  pane.innerHTML = `
    <div class="pane-intro">${icon('zap', 18)}<div><b>Quick add</b><p class="muted small">Log calories and macros directly — perfect for restaurant meals or recipes you've already counted.</p></div></div>
    <form class="quick-form">${quickFields()}<button class="btn primary block lg" type="submit"></button></form>`;
  const btn = pane.querySelector('[type="submit"]');
  const label = () => { btn.textContent = `Add to ${mealName(ctx.meal)}`; };
  label();
  ctx.mealListeners.add(label);
  pane.querySelector('form').addEventListener('submit', async e => {
    e.preventDefault();
    const v = readQuick(pane);
    if (!v) return;
    await addEntry({ ...v, date: ctx.date, meal: ctx.meal, grams: 0 });
    ctx.onAdded(v.name, v.kcal);
    checkGoals(ctx.date);
    e.target.reset();
  });
}

const PANES = { search: searchPane, scan: scanPane, snap: snapPane, create: createPane, quick: quickPane };
