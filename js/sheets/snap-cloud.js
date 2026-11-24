// Snap AI, cloud engine: NVIDIA vision model → grounded items → editable results → diary.

import { estimateMealCloud, learnCorrections } from '../vision.js';
import { isConfigured, modelInfo } from '../cloud.js';
import { scale } from '../nutrition.js';
import { addEntries, getSettings } from '../store.js';
import { checkGoals } from '../celebrate.js';
import { PREPS } from '../ai.js';
import { icon } from '../icons.js';
import { esc, fmt, round, mealName, haptic } from '../util.js';

export function snapEngine() {
  const e = getSettings().ai?.engine || 'auto';
  if (e === 'local' || e === 'cloud') return e;
  return isConfigured() && navigator.onLine ? 'cloud' : 'local';
}

const CONF = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence — check it' };
const BASIS = {
  library: { label: 'Your food', cls: 'custom' },
  database: { label: 'Database', cls: 'builtin' },
  usda: { label: 'USDA', cls: 'usda' },
  model: { label: 'AI estimate', cls: 'ai' },
  user: { label: 'Your pick', cls: 'custom' },
};

export async function runCloudSnap(pane, ctx, { file, hint, photoUrl, alive, onRetake, onLocal, openPicker }) {
  const ai = getSettings().ai;
  const passLabel = ai.accuracy === 'high' ? ' · 2 passes' : '';
  pane.innerHTML = `
    <div class="snap-analyzing">
      <div class="snap-photo"><img src="${photoUrl}" alt=""><div class="scanline"></div><div class="snap-grid"></div></div>
      <ol class="steps">
        <li data-step="prepare"><span class="st-ico"></span><span class="st-label">Preparing photo</span><span class="st-pct"></span></li>
        <li data-step="vision"><span class="st-ico"></span><span class="st-label">Asking ${esc(modelInfo(ai.visionModel).label)}${passLabel}</span><span class="st-pct"></span></li>
        <li data-step="ground"><span class="st-ico"></span><span class="st-label">Matching items to nutrition data</span><span class="st-pct"></span></li>
      </ol>
      <p class="muted small center">${icon('cloud', 12)} Cloud AI: the photo goes to NVIDIA through your proxy.</p>
      <button class="btn ghost block" data-c="cancel">Cancel</button>
    </div>`;

  const ctrl = new AbortController();
  const order = ['prepare', 'vision', 'ground'];
  const onStep = (step, info) => {
    if (!alive()) return;
    const i = order.indexOf(step);
    pane.querySelectorAll('[data-step]').forEach((li, k) => {
      li.classList.toggle('done', step === 'done' || (i >= 0 && k < i));
      li.classList.toggle('active', k === i);
    });
    if (step === 'vision' && info) {
      const li = pane.querySelector('[data-step="vision"]');
      if (!li) return;
      if (info.model) li.querySelector('.st-label').textContent = `Asking ${modelInfo(info.model).label}${passLabel}`;
      if (info.chars) li.querySelector('.st-pct').textContent = info.thinking ? 'thinking…' : 'writing…';
    }
  };
  pane.querySelector('[data-c="cancel"]').onclick = () => { ctrl.abort(); onRetake(); };

  let result;
  try {
    result = await estimateMealCloud(file, { hint, onStep, signal: ctrl.signal });
  } catch (e) {
    if (e.name === 'AbortError' || !alive()) return;
    pane.innerHTML = `
      <div class="card scan-missing">
        <div class="missing-ico">☁️</div>
        <b>Cloud AI couldn't analyse this photo</b>
        <p class="muted small">${esc(e.message)}</p>
        <div class="row gap wrap">
          <button class="btn ghost" data-c="retry">${icon('refresh', 16)} Try again</button>
          <button class="btn primary grow" data-c="local">${icon('cpu', 16)} Use on-device AI</button>
        </div>
      </div>`;
    pane.querySelector('[data-c="retry"]').onclick = () => runCloudSnap(pane, ctx, { file, hint, photoUrl, alive, onRetake, onLocal, openPicker });
    pane.querySelector('[data-c="local"]').onclick = () => onLocal(file, hint);
    return;
  }
  if (!alive()) return;
  haptic(20);

  let items = result.items.map(it => ({ ...it, original: it }));

  const userPick = (item, food) => ({
    ...item,
    food: { ...food, emoji: food.emoji || '🍽️' },
    basis: 'user', adjust: null, prepId: null, check: false,
  });

  function card(it, k) {
    const b = BASIS[it.basis] || BASIS.model;
    const max = Math.max(600, Math.round((it.grams * 2.5) / 50) * 50);
    const seen = it.name && it.name.toLowerCase() !== it.food.name.toLowerCase() ? ` · seen as “${esc(it.name)}”` : '';
    const prep = it.prepId ? PREPS.find(p => p.id === it.prepId)?.label : '';
    return `
      <div class="ai-item" data-ck="${k}">
        <div class="ai-item-head">
          <span class="ai-emoji">${it.food.emoji || '🍽️'}</span>
          <div class="grow"><b>${esc(it.food.name)}</b><small class="muted"><span class="badge badge-${b.cls}">${b.label}</span>${seen}${it.count ? ` · ${it.count} pcs` : ''}</small></div>
          <button class="btn-icon ghost sm" data-crm="${k}" aria-label="Remove">${icon('x', 16)}</button>
        </div>
        <div class="grams-row">
          <input type="range" min="5" max="${max}" step="5" value="${Math.round(it.grams)}" data-crange="${k}" aria-label="Grams">
          <label class="grams-val"><input type="number" inputmode="numeric" value="${Math.round(it.grams)}" data-cgrams="${k}"><span>g</span></label>
        </div>
        ${it.low && it.high && it.basis !== 'user' ? `<div class="muted small">AI range ${Math.round(it.low)}–${Math.round(it.high)} g · ${Math.round(it.confidence * 100)}% sure${it.passes === 2 ? ' · both passes agree' : ''}</div>` : ''}
        ${prep ? `<div class="muted small density">${icon('flame', 12)} ${esc(it.cooking || prep)}: ${esc(prep.toLowerCase())} values applied</div>` : ''}
        ${it.adjust ? `<div class="muted small density">${icon('flame', 12)} Looks ${it.adjust > 1 ? 'richer' : 'lighter'} than a typical portion (${it.adjust > 1 ? '+' : ''}${Math.round((it.adjust - 1) * 100)}%)</div>` : ''}
        ${it.check ? `<div class="warn-text small">${icon('info', 12)} The AI's own calorie guess differs a lot. Check the match.</div>` : ''}
        ${it.notes && it.basis !== 'user' ? `<div class="muted small">${esc(it.notes)}</div>` : ''}
        <div class="row between"><div class="ai-macros" data-cm="${k}"></div><button class="link" data-cmatch="${k}">Change food</button></div>
      </div>`;
  }

  function draw() {
    pane.innerHTML = `
      <div class="snap-results">
        <div class="snap-top">
          <img class="snap-thumb" src="${photoUrl}" alt="">
          <div>
            <span class="conf conf-${result.confidence}">${CONF[result.confidence]}</span>
            <h3 data-c="headline"></h3>
            <div class="row gap-sm wrap">
              <span class="pill">${icon('cloud', 12)} ${esc(result.modelLabel)}</span>
              ${result.passes === 2 ? `<span class="pill">2 passes · ${Math.round(result.agreement * 100)}% agree</span>` : ''}
              ${hint ? `<span class="pill">${icon('bulb', 12)} Hint applied</span>` : ''}
            </div>
          </div>
        </div>
        ${result.summary ? `<p class="muted small">${esc(result.summary)}</p>` : ''}
        ${result.imageQuality === 'poor' ? `<p class="warn-text small">${icon('info', 13)} The photo is unclear, so estimates are rough.</p>` : ''}
        <div class="ai-items">${items.map(card).join('') || '<p class="empty">No food found. Add items yourself or try another photo.</p>'}</div>
        <button class="btn soft block" data-c="additem">${icon('plus', 16)} Add something it missed</button>
        <div class="card snap-total"></div>
        <div class="snap-actions">
          <button class="btn ghost" data-c="retake">${icon('camera', 18)} New photo</button>
          <button class="btn ghost" data-c="local">${icon('cpu', 18)} Try on-device</button>
        </div>
        <div class="pane-foot"><button class="btn primary block lg" data-c="add"></button></div>
      </div>`;
    totals();
  }

  function totals() {
    let t = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
    items.forEach((it, k) => {
      const n = scale(it.food.per100, it.grams);
      const el = pane.querySelector(`[data-cm="${k}"]`);
      if (el) el.innerHTML = `<span><b>${fmt(n.kcal || 0)}</b> kcal</span><span class="protein-text">P ${fmt(n.protein || 0, 1)}g</span><span class="carbs-text">C ${fmt(n.carbs || 0, 1)}g</span><span class="fat-text">F ${fmt(n.fat || 0, 1)}g</span>`;
      for (const key of Object.keys(t)) t[key] += n[key] || 0;
    });
    const tot = pane.querySelector('.snap-total');
    if (tot) tot.innerHTML = `
      <div class="snap-total-kcal"><b>${fmt(t.kcal)}</b><span>kcal total</span></div>
      <div class="snap-total-macros">
        <span class="protein-text"><b>${fmt(t.protein)}g</b> protein</span>
        <span class="carbs-text"><b>${fmt(t.carbs)}g</b> carbs</span>
        <span class="fat-text"><b>${fmt(t.fat)}g</b> fat</span>
      </div>`;
    const head = pane.querySelector('[data-c="headline"]');
    if (head) head.textContent = items.length ? `${items.length} item${items.length > 1 ? 's' : ''} · ${fmt(t.kcal)} kcal` : 'Nothing selected';
    const add = pane.querySelector('[data-c="add"]');
    if (add) {
      add.disabled = !items.length;
      add.textContent = items.length ? `Add ${items.length} item${items.length > 1 ? 's' : ''} to ${mealName(ctx.meal)}` : 'Nothing to add';
    }
  }

  pane.onclick = async e => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.crm != null) { items.splice(+t.dataset.crm, 1); draw(); return; }
    if (t.dataset.cmatch != null) {
      const k = +t.dataset.cmatch;
      openPicker({ query: items[k].search || items[k].name, title: 'Pick the right food', onPick: food => { items[k] = userPick(items[k], food); draw(); } });
      return;
    }
    const act = t.dataset.c;
    if (act === 'retake') onRetake();
    else if (act === 'local') onLocal(file, hint);
    else if (act === 'additem') {
      openPicker({ query: '', title: 'Add a food', onPick: food => { items.push(userPick({ name: food.name, grams: food.servings?.[0]?.grams || 100, confidence: 1, original: null }, food)); draw(); } });
    } else if (act === 'add' && items.length) {
      t.disabled = true;
      const entries = items.map(it => {
        const n = scale(it.food.per100, it.grams);
        return {
          date: ctx.date, meal: ctx.meal, foodId: it.food.id, name: it.food.name, brand: it.food.brand || '', emoji: it.food.emoji || '🍽️',
          image: result.thumb, source: 'ai', per100: it.food.per100, grams: Math.round(it.grams), qty: Math.round(it.grams), unit: 'g', unitGrams: 1,
          kcal: round(n.kcal || 0, 1), protein: round(n.protein || 0, 1), carbs: round(n.carbs || 0, 1), fat: round(n.fat || 0, 1),
          fiber: n.fiber != null ? round(n.fiber, 1) : undefined,
          ai: { engine: 'cloud', model: result.model, basis: it.basis, confidence: round(it.confidence || 0, 2) },
        };
      });
      await addEntries(entries);
      learnCorrections(items.filter(it => it.original).map(it => ({ before: it.original, after: it }))).catch(() => {});
      ctx.onAdded(entries.length > 1 ? `${entries.length} items` : entries[0].name, entries.reduce((s, x) => s + x.kcal, 0));
      checkGoals(ctx.date);
      onRetake();
    }
  };
  pane.oninput = e => {
    const el = e.target;
    const k = +(el.dataset.crange ?? el.dataset.cgrams ?? -1);
    if (k < 0 || !items[k]) return;
    const g = Math.max(1, Math.round(+el.value || 0));
    items[k].grams = g;
    const host = pane.querySelector(`[data-ck="${k}"]`);
    if (el.dataset.crange != null) host.querySelector('[data-cgrams]').value = g;
    else host.querySelector('[data-crange]').value = g;
    totals();
  };
  ctx.mealListeners.add(() => { if (alive()) totals(); });
  draw();
}
