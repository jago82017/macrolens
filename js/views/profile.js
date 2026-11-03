// Profile & settings: targets, macro calculator, preferences, AI model, food databases, data & storage.

import { getSettings, saveSettings, allFoods, deleteFood, exportAll, importAll, resetAll, emit } from '../store.js';
import { storageInfo, requestPersistence } from '../db.js';
import { kcalFromMacros, macroSplit } from '../nutrition.js';
import { openSheet, toast, confirmSheet } from '../ui.js';
import { icon } from '../icons.js';
import { esc, fmt, bytes, haptic, todayKey } from '../util.js';
import { calcForm } from '../sheets/calculator.js';
import { openFoodEditor, foodRow } from '../sheets/food.js';
import { prepareAI, isModelCached, memoryCount, clearMemory, aiState, MODEL_SIZE_MB } from '../ai.js';
import { installState, promptInstall } from '../install.js';

export const APP_VERSION = '1.0.0';

export async function render(el) {
  const s = getSettings();
  const tg = s.targets;
  const [info, cached, memCount, foods] = await Promise.all([storageInfo(), isModelCached(), memoryCount(), allFoods()]);
  const custom = foods.filter(f => f.source === 'custom');
  const sp = macroSplit(tg);
  const initials = (s.name || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();

  el.innerHTML = `
    <header class="topbar"><div><p class="eyebrow">Settings</p><h1>Profile</h1></div></header>

    <section class="card profile-card">
      <div class="row gap">
        <div class="avatar">${esc(initials)}</div>
        <div class="grow field nomargin">
          <label class="label">Your name</label>
          <input class="input" data-name placeholder="What should we call you?" value="${esc(s.name)}" maxlength="30">
        </div>
      </div>
      <div class="targets-row">
        <div class="t-kcal"><b>${fmt(tg.kcal)}</b><small>kcal</small></div>
        <div class="t-macro protein"><b>${tg.protein}g</b><small>Protein · ${Math.round(sp.protein * 100)}%</small></div>
        <div class="t-macro carbs"><b>${tg.carbs}g</b><small>Carbs · ${Math.round(sp.carbs * 100)}%</small></div>
        <div class="t-macro fat"><b>${tg.fat}g</b><small>Fat · ${Math.round(sp.fat * 100)}%</small></div>
      </div>
      <button class="btn soft block" data-act="targets">${icon('sliders', 18)} Edit targets manually</button>
    </section>

    <section class="card">
      <div class="card-head"><h3>${icon('calc', 18)} Macro calculator</h3></div>
      <p class="muted small">Mifflin-St Jeor BMR × activity, adjusted for your goal, then split by diet style.</p>
      <div class="calc-host"></div>
    </section>

    <section class="card settings">
      <div class="card-head"><h3>${icon('sliders', 18)} Preferences</h3></div>
      <div class="set-row"><span>Units</span>
        <div class="seg sm" data-pref="units"><button data-v="metric" class="${s.units === 'metric' ? 'active' : ''}">Metric</button><button data-v="imperial" class="${s.units === 'imperial' ? 'active' : ''}">Imperial</button></div>
      </div>
      <div class="set-row"><span>Theme</span>
        <div class="seg sm" data-pref="theme">${['system', 'light', 'dark'].map(t => `<button data-v="${t}" class="${s.theme === t ? 'active' : ''}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
      </div>
      <label class="set-row"><span>Goal celebrations<small class="muted">Confetti when you hit a target</small></span><input type="checkbox" class="switch" data-toggle="celebrations" ${s.celebrations ? 'checked' : ''}></label>
      <label class="set-row"><span>Haptic feedback</span><input type="checkbox" class="switch" data-toggle="haptics" ${s.haptics ? 'checked' : ''}></label>
    </section>

    <section class="card">
      <div class="card-head"><h3>${icon('cpu', 18)} On-device AI</h3><span class="badge ${cached ? 'badge-ok' : ''}">${cached ? 'Ready offline' : 'Not downloaded'}</span></div>
      <p class="muted small">MobileCLIP-S0 runs locally via WebAssembly. Photos are never uploaded. It identifies the food and the app injects verified nutrition data, then refines with portion, cooking-method and calorie-density passes.</p>
      <div class="ai-dl" ${cached ? 'hidden' : ''}>
        <div class="pbar lg"><span class="ai-bar" style="width:0;background:linear-gradient(90deg,var(--brand),var(--brand-2))"></span></div>
        <p class="muted small ai-msg">${MODEL_SIZE_MB.vision + MODEL_SIZE_MB.text} MB one-time download (image + text towers). Use Wi-Fi if you can.</p>
        <button class="btn primary block" data-act="ai-dl">${icon('download', 18)} Download model now</button>
      </div>
      <div class="set-row"><span>Learned meals<small class="muted">Photos you confirmed — used to recognise your regulars</small></span><b>${memCount}</b></div>
      ${memCount ? `<button class="btn ghost block danger-text" data-act="ai-clear">${icon('trash', 16)} Forget learned meals</button>` : ''}
    </section>

    <section class="card">
      <div class="card-head"><h3>${icon('database', 18)} Food databases</h3></div>
      <div class="field">
        <label class="label">USDA FoodData Central API key</label>
        <input class="input" data-usda placeholder="Using shared DEMO_KEY (rate-limited)" value="${esc(s.usdaKey)}" autocomplete="off" spellcheck="false">
        <p class="muted small">Free at <a class="link" href="https://fdc.nal.usda.gov/api-key-signup" target="_blank" rel="noopener">fdc.nal.usda.gov</a>. Open Food Facts needs no key.</p>
      </div>
      <button class="set-row as-btn" data-act="foods"><span>My custom foods<small class="muted">${custom.length} saved</small></span>${icon('chevR', 18)}</button>
      <button class="btn soft block" data-act="newfood">${icon('plus', 18)} Create custom food</button>
    </section>

    <section class="card">
      <div class="card-head"><h3>${icon('shield', 18)} Data & storage</h3></div>
      <div class="set-row"><span>Persistent storage<small class="muted">${info.persisted ? 'Protected from automatic browser cleanup' : 'Browser may clear data when space is low'}</small></span>
        ${info.persisted ? `<span class="badge badge-ok">${icon('check', 12)} On</span>` : `<button class="btn soft sm" data-act="persist">Enable</button>`}</div>
      <div class="set-row"><span>Space used<small class="muted">Diary, foods, AI cache</small></span><b>${bytes(info.usage)}</b></div>
      <div class="grid2">
        <button class="btn soft" data-act="export">${icon('download', 18)} Export</button>
        <label class="btn soft">${icon('upload', 18)} Import<input type="file" accept="application/json,.json" hidden data-import></label>
      </div>
      <button class="btn ghost block danger-text" data-act="reset">${icon('trash', 16)} Erase all data</button>
    </section>

    <section class="card about">
      ${installState.canInstall ? `<button class="btn primary block" data-act="install">${icon('phone', 18)} Install app</button>` : installState.installed ? `<p class="ok-text small center">${icon('check', 14)} Installed as an app</p>` : ''}
      <p class="muted small center">Macrolens v${APP_VERSION} · Data stays on this device<br>Product data © Open Food Facts contributors (ODbL) · USDA FoodData Central</p>
    </section>
    <div class="bottom-space"></div>`;

  calcForm(el.querySelector('.calc-host'), {
    profile: s.profile,
    units: s.units,
    onApply: async (profile, t) => {
      await saveSettings({ profile, targets: { kcal: t.kcal, protein: t.protein, carbs: t.carbs, fat: t.fat, fiber: t.fiber, water: t.water } });
      haptic(20);
      toast('Targets updated', { icon: 'check' });
    },
  });

  el.querySelector('[data-name]').addEventListener('change', e => saveSettings({ name: e.target.value.trim() }));
  el.querySelector('[data-usda]').addEventListener('change', e => { saveSettings({ usdaKey: e.target.value.trim() }); toast('USDA key saved', { icon: 'check' }); });
  el.querySelectorAll('[data-toggle]').forEach(t => t.addEventListener('change', () => saveSettings({ [t.dataset.toggle]: t.checked })));
  el.querySelector('[data-import]').addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await importAll(JSON.parse(await file.text()));
      toast('Backup restored', { icon: 'check' });
    } catch (err) { toast(err.message || 'Import failed', { icon: 'info' }); }
  });

  el.onclick = async e => {
    const pref = e.target.closest('[data-pref] [data-v]');
    if (pref) { await saveSettings({ [pref.closest('[data-pref]').dataset.pref]: pref.dataset.v }); return; }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'targets') openTargetsSheet();
    if (act === 'foods') openFoodsManager();
    if (act === 'newfood') openFoodEditor(null);
    if (act === 'install') promptInstall();
    if (act === 'persist') {
      const ok = await requestPersistence();
      toast(ok ? 'Persistent storage enabled' : 'Browser declined — installing the app usually grants it', { icon: ok ? 'check' : 'info' });
      if (ok) emit('settings');
    }
    if (act === 'export') {
      const data = await exportAll();
      const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `macrolens-backup-${todayKey()}.json` });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      toast('Backup downloaded', { icon: 'download' });
    }
    if (act === 'reset') {
      const ok = await confirmSheet({ title: 'Erase everything?', message: 'This permanently deletes your diary, foods, weights and learned meals from this device. Export a backup first if you might want it.', ok: 'Erase all data', danger: true });
      if (ok) { await resetAll(); location.reload(); }
    }
    if (act === 'ai-clear') {
      const ok = await confirmSheet({ title: 'Forget learned meals?', message: 'The AI will stop recognising meals from your past confirmations.', ok: 'Forget', danger: true });
      if (ok) { await clearMemory(); emit('settings'); }
    }
    if (act === 'ai-dl') {
      const btn = e.target.closest('button');
      btn.disabled = true;
      const bar = el.querySelector('.ai-bar'), msg = el.querySelector('.ai-msg');
      try {
        await prepareAI((stage, p) => {
          bar.style.width = `${Math.round((stage === 'model' ? p * 0.85 : 0.85 + p * 0.15) * 100)}%`;
          msg.textContent = stage === 'model' ? `Downloading model… ${Math.round(p * 100)}%` : `Learning food vocabulary… ${Math.round(p * 100)}%`;
        });
        toast('AI model ready — works offline now', { icon: 'check' });
        emit('settings');
      } catch (err) {
        msg.textContent = err.message;
        btn.disabled = false;
      }
    }
  };

  if (aiState.status === 'loading') el.querySelector('.ai-msg').textContent = 'Download in progress…';
}

function openTargetsSheet() {
  const tg = getSettings().targets;
  const f = [['kcal', 'Calories', 'kcal'], ['protein', 'Protein', 'g'], ['carbs', 'Carbs', 'g'], ['fat', 'Fat', 'g'], ['fiber', 'Fiber', 'g'], ['water', 'Water', 'ml']];
  const sheet = openSheet({
    title: 'Daily targets',
    html: `<div class="grid2">${f.map(([k, l, u]) => `<div class="field"><label class="label ${['protein', 'carbs', 'fat'].includes(k) ? k + '-text' : ''}">${l} <span class="unit-hint">${u}</span></label><input class="input" type="number" inputmode="numeric" name="${k}" value="${tg[k]}"></div>`).join('')}</div>
      <p class="small kcal-check"></p>`,
    footer: `<button class="btn primary block lg" data-save>Save targets</button>`,
  });
  const v = k => parseFloat(sheet.el.querySelector(`[name="${k}"]`).value) || 0;
  const check = () => {
    const est = kcalFromMacros(v('protein'), v('carbs'), v('fat'));
    const diff = est - v('kcal');
    sheet.el.querySelector('.kcal-check').innerHTML = Math.abs(diff) > 60
      ? `<span class="warn-text">${icon('info', 14)} Macros add up to ${fmt(est)} kcal (${diff > 0 ? '+' : ''}${fmt(diff)} vs calorie target).</span>`
      : `<span class="ok-text">${icon('check', 14)} Macros add up to ${fmt(est)} kcal.</span>`;
  };
  sheet.el.addEventListener('input', check);
  sheet.el.querySelector('[data-save]').onclick = async () => {
    await saveSettings({ targets: Object.fromEntries(f.map(([k]) => [k, Math.max(0, Math.round(v(k)))])) });
    sheet.close();
    toast('Targets saved', { icon: 'check' });
  };
  check();
}

async function openFoodsManager() {
  const sheet = openSheet({ title: 'My custom foods', html: '<div class="list foods-list"></div>', full: true });
  const host = sheet.el.querySelector('.foods-list');
  const draw = async () => {
    const foods = (await allFoods()).filter(f => f.source === 'custom').sort((a, b) => a.name.localeCompare(b.name));
    host.innerHTML = foods.length
      ? foods.map(f => `<div class="manage-row">${foodRow(f)}<button class="btn-icon ghost sm" data-del="${esc(f.id)}" aria-label="Delete">${icon('trash', 16)}</button></div>`).join('')
      : `<p class="empty">No custom foods yet. Create one from the Add food sheet, or when a barcode isn't found.</p>`;
    host.onclick = async e => {
      const del = e.target.closest('[data-del]');
      const food = foods.find(f => f.id === (del?.dataset.del || e.target.closest('[data-fid]')?.dataset.fid));
      if (!food) return;
      if (del) {
        const ok = await confirmSheet({ title: 'Delete food?', message: `“${esc(food.name)}” will be removed. Diary entries that used it are kept.`, ok: 'Delete', danger: true });
        if (ok) { await deleteFood(food.id); draw(); }
      } else openFoodEditor(food, { onSaved: draw });
    };
  };
  draw();
}
