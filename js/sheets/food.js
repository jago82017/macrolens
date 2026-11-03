// Food presentation helpers + the Food Detail sheet (add / edit diary entry) + custom food form.

import { openSheet, toast, confirmSheet } from '../ui.js';
import { icon } from '../icons.js';
import { esc, fmt, round, MEALS, mealName, uid, haptic, relDay } from '../util.js';
import { scale, macroSplit, kcalFromMacros } from '../nutrition.js';
import { addEntry, updateEntry, deleteEntry, touchFood, toggleFavorite, getFood, saveFood, getSettings } from '../store.js';
import { categoryEmoji } from '../fooddb.js';
import { checkGoals } from '../celebrate.js';
import { gradeFood, gradeBadge, withGradeData, tierDot, TIERS } from '../grade.js';
import { refreshFood } from '../api.js';

export const SOURCE = {
  off: { label: 'Open Food Facts', short: 'OFF' },
  usda: { label: 'USDA', short: 'USDA' },
  custom: { label: 'My food', short: 'Mine' },
  builtin: { label: 'Generic', short: 'Generic' },
  ai: { label: 'AI estimate', short: 'AI' },
  quick: { label: 'Quick add', short: 'Quick' },
};

export function badge(source) {
  const s = SOURCE[source];
  return s ? `<span class="badge badge-${source}">${s.short}</span>` : '';
}

export function thumb(item, size = '') {
  if (item.image) return `<img class="thumb-img ${size}" src="${esc(item.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'thumb-emoji',textContent:'🍽️'}))">`;
  const e = item.emoji || (item.source === 'quick' ? '⚡' : item.category ? categoryEmoji(item.category) : item.source === 'off' ? '🛒' : item.source === 'usda' ? '🥕' : '🍽️');
  return `<span class="thumb-emoji">${e}</span>`;
}

export function unitOptions(food) {
  const units = (food.servings || []).filter(s => s.grams > 0).map(s => ({ label: s.label, grams: s.grams, text: `${s.label} (${fmt(s.grams, 1)} g)` }));
  units.push({ label: 'g', grams: 1, text: 'grams' });
  units.push({ label: 'oz', grams: 28.3495, text: 'ounces' });
  return units;
}

export function servingSummary(food) {
  const s = food.servings?.[0];
  if (s) {
    const kcal = ((food.per100?.kcal || 0) * s.grams) / 100;
    return { text: `${s.label} · ${fmt(s.grams, 1)} g`, kcal };
  }
  return { text: 'per 100 g', kcal: food.per100?.kcal || 0 };
}

// Small A–F badge for list rows (hidden when the user turns grades off in Profile).
export function rowGrade(food) {
  const settings = getSettings();
  if (settings.grades === false) return '';
  const g = gradeFood(food, settings);
  return g ? `<div class="li-grade">${gradeBadge(g)}</div>` : '';
}

export function foodRow(food) {
  const s = servingSummary(food);
  const sub = [food.brand, s.text].filter(Boolean).map(esc).join(' · ');
  return `<button class="food-row" data-fid="${esc(food.id)}">
    <div class="li-thumb">${thumb(food)}</div>
    <div class="li-main"><div class="li-title">${esc(food.name)} ${food.favorite ? `<span class="fav-dot">${icon('star', 12)}</span>` : ''}</div><div class="li-sub">${badge(food.source)} ${sub}</div></div>
    ${rowGrade(food)}
    <div class="li-end"><b>${fmt(s.kcal)}</b><small>kcal</small></div>
  </button>`;
}

const roundNutrients = n => Object.fromEntries(Object.entries(n).map(([k, v]) => [k, round(v, 1)]));

// Rebuild an editable food from a stored entry (entries snapshot per-100 g values).
export function foodFromEntry(e) {
  const servings = e.unit && e.unit !== 'g' && e.unit !== 'oz' && e.unitGrams ? [{ label: e.unit, grams: e.unitGrams }] : [];
  return { id: e.foodId || `entry:${e.id}`, name: e.name, brand: e.brand, emoji: e.emoji, image: e.image, source: e.source, per100: e.per100 || {}, servings };
}

/**
 * Food detail sheet. Adds a new entry, or edits an existing one when `entry` is passed.
 */
export function openFoodDetail(food, { date, meal, entry, onAdded, onClose } = {}) {
  if (entry && entry.source === 'quick') return openQuickEdit(entry);
  const editing = !!entry;
  const units = unitOptions(food);
  const gIdx = units.findIndex(u => u.label === 'g');
  let unitIdx = editing ? units.findIndex(u => u.label === entry.unit) : food.servings?.length ? 0 : gIdx;
  if (unitIdx < 0) unitIdx = gIdx;
  let qty = editing ? (entry.qty ?? entry.grams) : units[unitIdx].label === 'g' ? 100 : 1;
  let curMeal = entry?.meal || meal;
  const theDate = entry?.date || date;
  const targets = getSettings().targets;
  let favorite = !!food.favorite;

  const html = `
    <div class="fd-head">
      <div class="fd-thumb">${thumb(food, 'lg')}</div>
      <div class="fd-title">
        <h2>${esc(food.name)}</h2>
        <p class="muted small">${badge(food.source)} ${esc(food.brand || SOURCE[food.source]?.label || '')}</p>
      </div>
      ${food.source !== 'ai' && !String(food.id).startsWith('entry:') ? `<button class="btn-icon ghost fav ${favorite ? 'on' : ''}" data-fav aria-label="Favourite">${icon('star')}</button>` : ''}
    </div>

    <div class="grade-host"></div>

    <div class="fd-energy">
      <div><span class="fd-kcal" data-o="kcal">0</span><span class="muted"> kcal</span></div>
      <div class="muted small" data-o="pctday"></div>
    </div>
    <div class="split-bar" data-o="split"><span class="p"></span><span class="c"></span><span class="f"></span></div>
    <div class="fd-macros">
      <div class="fd-macro protein"><span class="dot"></span><b data-o="protein">0</b><small>Protein</small></div>
      <div class="fd-macro carbs"><span class="dot"></span><b data-o="carbs">0</b><small>Carbs</small></div>
      <div class="fd-macro fat"><span class="dot"></span><b data-o="fat">0</b><small>Fat</small></div>
    </div>

    <div class="field">
      <label class="label">Amount</label>
      <div class="amount-row">
        <div class="stepper">
          <button type="button" class="btn-icon" data-step="-1" aria-label="Less">${icon('minus', 18)}</button>
          <input class="input qty" type="number" inputmode="decimal" step="any" min="0" value="${qty}">
          <button type="button" class="btn-icon" data-step="1" aria-label="More">${icon('plus', 18)}</button>
        </div>
        <select class="input unit">${units.map((u, i) => `<option value="${i}" ${i === unitIdx ? 'selected' : ''}>${esc(u.text)}</option>`).join('')}</select>
      </div>
      <div class="quick-qty"></div>
    </div>

    <div class="field">
      <label class="label">Meal · ${esc(relDay(theDate))}</label>
      <div class="meal-chips compact">${MEALS.map(m => `<button type="button" class="chip ${m.id === curMeal ? 'active' : ''}" data-meal="${m.id}">${m.emoji} ${m.name}</button>`).join('')}</div>
    </div>

    <details class="fd-more">
      <summary>Full nutrition</summary>
      <table class="nutr-table" data-o="table"></table>
    </details>`;

  const footer = editing
    ? `<button class="btn ghost danger-text" data-del>${icon('trash', 18)} Delete</button><button class="btn primary grow" data-save>Save changes</button>`
    : `<button class="btn primary block lg" data-save>Add to ${mealName(curMeal)}</button>`;

  const sheet = openSheet({ html, footer, className: 'food-sheet', onClose });
  const $ = s => sheet.el.querySelector(s);
  const qtyInput = $('.qty');
  const unitSel = $('.unit');

  const grams = () => (+qtyInput.value || 0) * units[unitIdx].grams;

  function quickChips() {
    const u = units[unitIdx];
    const opts = u.label === 'g' ? [50, 100, 150, 200, 250] : u.label === 'oz' ? [1, 2, 4, 6, 8] : [0.5, 1, 1.5, 2, 3];
    $('.quick-qty').innerHTML = opts.map(v => `<button type="button" class="chip sm ${+qtyInput.value === v ? 'active' : ''}" data-q="${v}">${v === 0.5 ? '½' : v === 1.5 ? '1½' : v}</button>`).join('');
  }

  function update() {
    const g = grams();
    const n = scale(food.per100, g);
    const sp = macroSplit(n);
    $('[data-o="kcal"]').textContent = fmt(n.kcal || 0);
    $('[data-o="protein"]').textContent = `${fmt(n.protein || 0, 1)} g`;
    $('[data-o="carbs"]').textContent = `${fmt(n.carbs || 0, 1)} g`;
    $('[data-o="fat"]').textContent = `${fmt(n.fat || 0, 1)} g`;
    $('[data-o="pctday"]').textContent = targets.kcal ? `${fmt(((n.kcal || 0) / targets.kcal) * 100)}% of daily target · ${fmt(g, 1)} g` : '';
    const bar = $('[data-o="split"]').children;
    bar[0].style.width = `${sp.protein * 100}%`;
    bar[1].style.width = `${sp.carbs * 100}%`;
    bar[2].style.width = `${sp.fat * 100}%`;
    const rows = [
      ['Calories', 'kcal', 'kcal'], ['Protein', 'protein', 'g'], ['Carbohydrates', 'carbs', 'g'], ['  of which sugars', 'sugar', 'g'],
      ['Fat', 'fat', 'g'], ['  of which saturated', 'satFat', 'g'], ['Fiber', 'fiber', 'g'], ['Sodium', 'sodium', 'mg'],
    ].filter(([, k]) => food.per100?.[k] != null);
    $('[data-o="table"]').innerHTML = `<tr><th></th><th>${esc(fmt(g, 1))} g</th><th>100 g</th></tr>` +
      rows.map(([l, k, u]) => `<tr class="${l.startsWith(' ') ? 'sub' : ''}"><td>${l.trim()}</td><td>${fmt(n[k], 1)} ${u}</td><td>${fmt(food.per100[k], 1)} ${u}</td></tr>`).join('');
    quickChips();
  }

  sheet.el.addEventListener('click', async e => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.step) {
      const u = units[unitIdx];
      const step = u.label === 'g' ? 10 : u.label === 'oz' ? 0.5 : 0.5;
      qtyInput.value = Math.max(0, round((+qtyInput.value || 0) + step * +t.dataset.step, 2));
      haptic(5);
      update();
    } else if (t.dataset.q) {
      qtyInput.value = t.dataset.q;
      update();
    } else if (t.dataset.meal) {
      curMeal = t.dataset.meal;
      sheet.el.querySelectorAll('[data-meal]').forEach(b => b.classList.toggle('active', b === t));
      if (!editing) $('[data-save]').textContent = `Add to ${mealName(curMeal)}`;
    } else if (t.hasAttribute('data-fav')) {
      favorite = await toggleFavorite(food);
      food.favorite = favorite;
      t.classList.toggle('on', favorite);
      haptic(10);
    } else if (t.hasAttribute('data-del')) {
      const removed = await deleteEntry(entry.id);
      sheet.close();
      toast(`Removed ${entry.name}`, { action: 'Undo', icon: 'trash', onAction: () => addEntry(removed) });
    } else if (t.hasAttribute('data-save')) {
      const g = grams();
      if (!(g > 0)) { qtyInput.focus(); return; }
      const u = units[unitIdx];
      const n = roundNutrients(scale(food.per100, g));
      const data = {
        date: theDate, meal: curMeal, foodId: food.id, name: food.name, brand: food.brand || '', emoji: food.emoji || '',
        image: food.image || '', source: food.source, per100: food.per100, grams: round(g, 1), qty: +qtyInput.value, unit: u.label, unitGrams: u.grams,
        kcal: 0, protein: 0, carbs: 0, fat: 0, ...n,
      };
      haptic(15);
      if (editing) {
        await updateEntry({ ...entry, ...data });
        sheet.close();
        toast('Entry updated', { icon: 'check' });
      } else {
        await addEntry(data);
        if (!String(food.id).startsWith('entry:')) await touchFood(food);
        sheet.close('added');
        onAdded?.(data);
      }
      checkGoals(theDate);
    }
  });
  mountGradeCard(sheet.el.querySelector('.grade-host'), food);
  qtyInput.addEventListener('input', update);
  unitSel.addEventListener('change', () => {
    const before = grams();
    unitIdx = +unitSel.value;
    const u = units[unitIdx];
    qtyInput.value = u.label === 'g' ? round(before, 0) : round(before / u.grams, 2) || 1;
    update();
  });
  update();
  return sheet;
}

// ---------- Diet-fit grade card ----------
// Shows the A–F grade, the main reasons, and a full breakdown (every factor, additives, ingredients).
// Diary entries only snapshot nutrition, so the stored food is looked up to recover additives/NOVA.
// Products saved before grading existed are refreshed from Open Food Facts in the background.
async function mountGradeCard(host, food) {
  if (!host || food.source === 'quick') return;
  let current = withGradeData(food, null);
  const draw = (state = {}) => {
    const g = gradeFood(current, getSettings());
    host.innerHTML = g ? gradeCard(g, current, state) : '';
  };
  draw();
  const id = String(food.id || '');
  if (!id.startsWith('builtin:') && !id.startsWith('entry:')) {
    const stored = await getFood(id).catch(() => null);
    if (stored) { current = withGradeData({ ...current }, stored); draw(); }
  }
  const canRefresh = () => current.source === 'off' && current.barcode;
  const refresh = async () => {
    draw({ loading: true });
    try {
      const fresh = await refreshFood(current);
      if (fresh) current = withGradeData({ ...current, ...pickGrade(fresh) }, fresh);
      draw(fresh ? {} : { error: 'Not found on Open Food Facts' });
    } catch (e) {
      draw({ error: navigator.onLine ? 'Couldn\'t reach Open Food Facts' : 'You\'re offline' });
    }
  };
  host.addEventListener('click', e => { if (e.target.closest('[data-refresh]')) refresh(); });
  if (canRefresh() && current.additives === undefined && navigator.onLine) refresh();
}

const GRADE_KEYS = ['additives', 'additivesKnown', 'nova', 'nutriscore', 'group1', 'group2', 'ingredients'];
const pickGrade = f => Object.fromEntries(GRADE_KEYS.filter(k => f[k] !== undefined).map(k => [k, f[k]]));

function gradeCard(g, food, { loading, error } = {}) {
  const real = g.factors.filter(f => !f.ref);
  const good = real.filter(f => f.pts >= 3).slice(0, 2);
  const bad = real.filter(f => f.pts <= -3).slice(0, 3);
  const chips = [...bad, ...good].sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts))
    .map(f => `<span class="gc-chip ${f.pts > 0 ? 'good' : 'bad'}">${icon(f.pts > 0 ? 'check' : 'x', 12)}${esc(f.title)}</span>`).join('');
  const sign = n => (n > 0 ? `+${n}` : n === 0 ? '·' : `−${Math.abs(n)}`);
  const factorList = real.map(f => `
      <li class="gf ${f.pts > 0 ? 'good' : f.pts < 0 ? 'bad' : 'info'}">
        <span class="gf-pts">${sign(f.pts)}</span>
        <div><b>${esc(f.title)}</b><small>${esc(f.detail)}</small></div>
      </li>`).join('');
  const ref = g.factors.find(f => f.ref);
  const additives = g.additives.length ? `
      <h5 class="gc-h">Additives <span class="muted">(${g.additives.length})</span></h5>
      <ul class="gc-adds">${g.additives.map(a => `
        <li>${tierDot(a.tier)}<div><b>${esc(a.label)} ${esc(a.name)}</b> <span class="tier-label tier-${a.tier ?? 'x'}">${a.tier == null ? 'Unrated' : TIERS[a.tier].short}</span><small>${esc(a.note)}</small></div></li>`).join('')}
      </ul>
      <p class="muted tiny">${g.additivesFrom === 'ingredients' ? 'Found by reading the ingredients list.' : 'From the product label via Open Food Facts.'}</p>` : '';
  const refreshBtn = food.source === 'off' && food.barcode
    ? `<button class="btn soft sm block" data-refresh ${loading ? 'disabled' : ''}>${icon('refresh', 15)} ${loading ? 'Loading product data…' : 'Refresh product data'}</button>${error ? `<p class="warn-text tiny center">${esc(error)}</p>` : ''}`
    : '';
  return `
    <section class="grade-card gc-${g.letter.toLowerCase()}">
      <div class="gc-top">
        ${gradeBadge(g, 'xl')}
        <div class="gc-text">
          <b>${esc(g.verdict)}</b>
          <small>Diet fit ${g.score}/100 · ${esc(g.plan)}</small>
        </div>
        ${loading ? '<div class="spinner sm"></div>' : ''}
      </div>
      ${chips ? `<div class="gc-chips">${chips}</div>` : ''}
      ${g.capped ? `<p class="gc-cap">${icon('info', 13)} Capped at ${g.capped.letter}: ${esc(g.capped.reason)}</p>` : ''}
      <details class="gc-more">
        <summary>Why ${g.letter}?</summary>
        <ul class="gc-factors">${factorList}</ul>
        ${additives}
        ${food.ingredients ? `<h5 class="gc-h">Ingredients</h5><p class="gc-ingr">${esc(food.ingredients)}</p>` : ''}
        ${ref ? `<p class="muted tiny">${esc(ref.title)}: ${esc(ref.detail)}</p>` : ''}
        ${g.notes.map(t => `<p class="muted tiny">${esc(t)}</p>`).join('')}
        ${refreshBtn}
        <p class="muted tiny">Grades judge the food per 100 g against your goal and diet style in Profile, not the portion. They're a guide, not medical advice.</p>
      </details>
    </section>`;
}

// Quick-add entries have no food behind them, so they get a direct macro editor.
export function openQuickEdit(entry) {
  const sheet = openSheet({
    title: 'Edit quick add',
    html: quickFields(entry),
    footer: `<button class="btn ghost danger-text" data-del>${icon('trash', 18)} Delete</button><button class="btn primary grow" data-save>Save</button>`,
  });
  sheet.el.querySelector('[data-del]').onclick = async () => {
    const removed = await deleteEntry(entry.id);
    sheet.close();
    toast(`Removed ${entry.name}`, { action: 'Undo', icon: 'trash', onAction: () => addEntry(removed) });
  };
  sheet.el.querySelector('[data-save]').onclick = async () => {
    const v = readQuick(sheet.el);
    if (!v) return;
    await updateEntry({ ...entry, ...v });
    sheet.close();
    checkGoals(entry.date);
  };
  return sheet;
}

export function quickFields(e = {}) {
  return `
    <div class="field"><label class="label">Description</label><input class="input" name="qname" placeholder="Quick add" value="${esc(e.name && e.name !== 'Quick add' ? e.name : '')}"></div>
    <div class="field"><label class="label">Calories</label><input class="input input-xl" name="qkcal" type="number" inputmode="decimal" placeholder="Auto from macros" value="${e.kcal != null ? round(e.kcal) : ''}"></div>
    <div class="grid3">
      <div class="field"><label class="label protein-text">Protein (g)</label><input class="input" name="qprotein" type="number" inputmode="decimal" placeholder="0" value="${e.protein ?? ''}"></div>
      <div class="field"><label class="label carbs-text">Carbs (g)</label><input class="input" name="qcarbs" type="number" inputmode="decimal" placeholder="0" value="${e.carbs ?? ''}"></div>
      <div class="field"><label class="label fat-text">Fat (g)</label><input class="input" name="qfat" type="number" inputmode="decimal" placeholder="0" value="${e.fat ?? ''}"></div>
    </div>`;
}

export function readQuick(root) {
  const v = n => parseFloat(root.querySelector(`[name="${n}"]`).value);
  const protein = v('qprotein') || 0, carbs = v('qcarbs') || 0, fat = v('qfat') || 0;
  let kcal = v('qkcal');
  if (!(kcal >= 0)) kcal = kcalFromMacros(protein, carbs, fat);
  if (!(kcal > 0)) { root.querySelector('[name="qkcal"]').focus(); toast('Enter calories or macros', { icon: 'info' }); return null; }
  return { name: root.querySelector('[name="qname"]').value.trim() || 'Quick add', kcal: round(kcal), protein, carbs, fat, emoji: '⚡', source: 'quick' };
}

// ---------- Custom food form ----------
const EMOJIS = ['🍽️', '🥗', '🍲', '🥪', '🍝', '🍛', '🍳', '🥣', '🍗', '🥩', '🐟', '🍕', '🍔', '🌯', '🍜', '🍣', '🍎', '🥤', '🍰', '🍫'];
const NUTR_FIELDS = [
  ['kcal', 'Calories', 'kcal', true], ['protein', 'Protein', 'g'], ['carbs', 'Carbs', 'g'], ['fat', 'Fat', 'g'],
  ['fiber', 'Fiber', 'g'], ['sugar', 'Sugars', 'g'], ['satFat', 'Saturated fat', 'g'], ['sodium', 'Sodium', 'mg'],
];

export function foodForm(container, { food, barcode = '', name = '', submitLabel = 'Save food', onSave }) {
  const s = food?.servings?.[0];
  let basis = s ? 'serving' : '100';
  let emoji = food?.emoji || '🍽️';
  const valFor = k => {
    const v = food?.per100?.[k];
    if (v == null) return '';
    return basis === 'serving' && s ? round((v * s.grams) / 100, 1) : round(v, 1);
  };
  container.innerHTML = `
    <form class="food-form" novalidate>
      <div class="emoji-row">${EMOJIS.map(e => `<button type="button" class="emoji-opt ${e === emoji ? 'on' : ''}" data-emoji="${e}">${e}</button>`).join('')}</div>
      <div class="field"><label class="label">Food name *</label><input class="input" name="name" required maxlength="80" placeholder="e.g. Grandma's lasagna" value="${esc(food?.name || name)}"></div>
      <div class="grid2">
        <div class="field"><label class="label">Brand</label><input class="input" name="brand" maxlength="60" placeholder="Optional" value="${esc(food?.brand || '')}"></div>
        <div class="field"><label class="label">Barcode</label><input class="input" name="barcode" inputmode="numeric" placeholder="Optional" value="${esc(food?.barcode || barcode)}"></div>
      </div>
      <div class="grid2">
        <div class="field"><label class="label">Serving name</label><input class="input" name="servingLabel" placeholder="1 slice" value="${esc(s?.label || '')}"></div>
        <div class="field"><label class="label">Serving size (g / ml)</label><input class="input" name="servingGrams" type="number" inputmode="decimal" placeholder="e.g. 40" value="${s?.grams ?? ''}"></div>
      </div>
      <div class="field">
        <label class="label">Nutrition values are</label>
        <div class="seg" data-basis>
          <button type="button" data-v="serving" class="${basis === 'serving' ? 'active' : ''}">Per serving</button>
          <button type="button" data-v="100" class="${basis === '100' ? 'active' : ''}">Per 100 g</button>
        </div>
      </div>
      <div class="grid2 nutr-grid">
        ${NUTR_FIELDS.map(([k, l, u, req]) => `<div class="field"><label class="label ${['protein', 'carbs', 'fat'].includes(k) ? k + '-text' : ''}">${l}${req ? ' *' : ''} <span class="unit-hint">${u}</span></label><input class="input" name="${k}" type="number" inputmode="decimal" step="any" min="0" value="${valFor(k)}"></div>`).join('')}
      </div>
      <div class="kcal-check small"></div>
      <div class="field">
        <label class="label">Ingredients <span class="unit-hint">optional</span></label>
        <textarea class="input textarea" name="ingredients" rows="3" maxlength="1500" placeholder="Paste from the label to check additives and processing, e.g. Wheat flour, sugar, palm oil, emulsifier (E471)…">${esc(food?.ingredients || '')}</textarea>
      </div>
      <button class="btn primary block lg" type="submit">${esc(submitLabel)}</button>
    </form>`;

  const form = container.querySelector('form');
  const num = n => parseFloat(form.elements[n].value);
  const check = () => {
    const p = num('protein') || 0, c = num('carbs') || 0, f = num('fat') || 0;
    const est = kcalFromMacros(p, c, f);
    const kcal = num('kcal');
    const el = container.querySelector('.kcal-check');
    if (!est) { el.innerHTML = ''; return; }
    if (!(kcal > 0)) el.innerHTML = `<span class="muted">Macros add up to <b>${fmt(est)}</b> kcal.</span> <button type="button" class="link" data-usekcal="${round(est)}">Use it</button>`;
    else if (Math.abs(kcal - est) / Math.max(kcal, est) > 0.15) el.innerHTML = `<span class="warn-text">${icon('info', 14)} Macros suggest ${fmt(est)} kcal — double-check the label.</span> <button type="button" class="link" data-usekcal="${round(est)}">Use ${fmt(est)}</button>`;
    else el.innerHTML = `<span class="ok-text">${icon('check', 14)} Calories match the macros.</span>`;
  };
  form.addEventListener('input', check);
  form.addEventListener('click', e => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.emoji) {
      emoji = t.dataset.emoji;
      form.querySelectorAll('.emoji-opt').forEach(b => b.classList.toggle('on', b === t));
    } else if (t.dataset.v) {
      basis = t.dataset.v;
      form.querySelectorAll('[data-basis] button').forEach(b => b.classList.toggle('active', b === t));
    } else if (t.dataset.usekcal) {
      form.elements.kcal.value = t.dataset.usekcal;
      check();
    }
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const nameV = form.elements.name.value.trim();
    if (!nameV) { form.elements.name.focus(); toast('Give your food a name', { icon: 'info' }); return; }
    const sg = num('servingGrams');
    if (basis === 'serving' && !(sg > 0)) { form.elements.servingGrams.focus(); toast('Enter the serving size in grams', { icon: 'info' }); return; }
    const factor = basis === 'serving' ? 100 / sg : 1;
    const per100 = {};
    for (const [k] of NUTR_FIELDS) { const v = num(k); if (v >= 0) per100[k] = round(v * factor, 2); }
    if (!(per100.kcal >= 0)) {
      const est = kcalFromMacros(per100.protein || 0, per100.carbs || 0, per100.fat || 0);
      if (!est) { form.elements.kcal.focus(); toast('Enter calories (or macros)', { icon: 'info' }); return; }
      per100.kcal = round(est, 1);
    }
    const code = form.elements.barcode.value.replace(/\D/g, '');
    const saved = await saveFood({
      ...(food || {}),
      id: food?.id || `custom:${uid()}`,
      source: 'custom',
      name: nameV,
      brand: form.elements.brand.value.trim(),
      barcode: code || undefined,
      emoji,
      per100,
      servings: sg > 0 ? [{ label: form.elements.servingLabel.value.trim() || 'serving', grams: sg }] : [],
      ingredients: form.elements.ingredients.value.replace(/\s+/g, ' ').trim() || undefined,
    });
    haptic(15);
    onSave?.(saved);
  });
  check();
}

export function openFoodEditor(food, { onSaved } = {}) {
  const sheet = openSheet({ title: food ? 'Edit food' : 'New food', html: '<div class="form-host"></div>', className: 'food-sheet' });
  foodForm(sheet.el.querySelector('.form-host'), {
    food,
    submitLabel: food ? 'Save changes' : 'Create food',
    onSave: f => { sheet.close(); toast(`${f.name} saved`, { icon: 'check' }); onSaved?.(f); },
  });
  return sheet;
}

export async function confirmDeleteFood(food) {
  const ok = await confirmSheet({ title: 'Delete food?', message: `“${esc(food.name)}” will be removed from your foods. Diary entries that use it are kept.`, ok: 'Delete', danger: true });
  return ok;
}

export { getFood };
