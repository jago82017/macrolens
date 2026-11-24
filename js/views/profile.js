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
import { GRADES, TIERS, planLabel, tierDot } from '../grade.js';
import { MODELS, modelInfo, isConfigured, testConnection, listModels, resetQuirks } from '../cloud.js';
import { openAISetupGuide } from '../sheets/aisetup.js';

export const APP_VERSION = '1.2.0';

function modelOptions(current, visionOnly) {
  const list = MODELS.filter(m => !visionOnly || m.vision);
  const opts = list.map(m => `<option value="${esc(m.id)}" ${m.id === current ? 'selected' : ''}>${esc(m.label)} · ${esc(m.vendor)}</option>`);
  if (current && !list.some(m => m.id === current)) opts.push(`<option value="${esc(current)}" selected>${esc(current)} (custom)</option>`);
  return opts.join('');
}

function segRow(key, label, sub, options, value) {
  return `<div class="set-row stack-sm"><span>${label}${sub ? `<small class="muted">${sub}</small>` : ''}</span>
    <div class="seg sm" data-aiseg="${key}">${options.map(([v, l]) => `<button data-v="${v}" class="${value === v ? 'active' : ''}">${l}</button>`).join('')}</div></div>`;
}

function aiCard(s) {
  const ai = s.ai;
  const ok = isConfigured();
  return `
    <section class="card ai-card" id="ai-settings">
      <div class="card-head"><h3>${icon('cloud', 18)} Cloud AI · NVIDIA</h3><span class="badge ${ok ? 'badge-ok' : ''}">${ok ? 'Proxy set' : 'Not set up'}</span></div>
      <p class="muted small">Powers <b>Coach</b> and the most accurate <b>Snap AI</b> estimates using NVIDIA's free hosted models (Kimi, Nemotron and more). Browsers need a small free proxy to reach NVIDIA.</p>
      <button class="btn soft block" data-act="ai-guide">${icon('bulb', 18)} Setup guide (3 minutes)</button>
      <div class="field" style="margin-top:12px">
        <label class="label">Proxy URL</label>
        <input class="input" data-ai="endpoint" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://macrolens-ai.yourname.workers.dev" value="${esc(ai.endpoint)}">
      </div>
      <div class="field">
        <label class="label">NVIDIA API key <span class="unit-hint">leave empty if your proxy stores it</span></label>
        <input class="input" type="password" data-ai="apiKey" autocomplete="off" spellcheck="false" placeholder="nvapi-…" value="${esc(ai.apiKey)}">
      </div>
      <button class="btn primary block" data-act="ai-test" ${ok ? '' : 'disabled'}>${icon('zap', 18)} Test connection</button>
      <p class="small ai-test-msg"></p>
      <div class="field">
        <label class="label">Photo model (vision)</label>
        <select class="input" data-ai="visionModel">${modelOptions(ai.visionModel, true)}</select>
      </div>
      <div class="field">
        <label class="label">Coach model</label>
        <select class="input" data-ai="agentModel">${modelOptions(ai.agentModel, false)}</select>
        <p class="muted small">${esc(modelInfo(ai.agentModel).note || 'Custom model')}</p>
      </div>
      ${segRow('effort', 'Reasoning', 'Deeper is more accurate but slower', [['fast', 'Fast'], ['balanced', 'Balanced'], ['deep', 'Deep']], ai.effort)}
      ${segRow('accuracy', 'Photo accuracy', 'High runs two independent passes and merges them', [['standard', 'Standard'], ['high', 'High']], ai.accuracy)}
      ${segRow('engine', 'Snap AI engine', 'Auto uses cloud when connected and online', [['auto', 'Auto'], ['cloud', 'Cloud'], ['local', 'On-device']], ai.engine)}
      ${segRow('approval', 'Coach asks before', 'Every change can still be undone', [['destructive', 'Big changes'], ['all', 'Any change'], ['none', 'Never']], ai.approval)}
      <div class="set-row"><span>Learned corrections<small class="muted">Your fixes to cloud photo estimates, fed back to the model</small></span><b>${(ai.corrections || []).length}</b></div>
      ${(ai.corrections || []).length ? `<button class="btn ghost block danger-text" data-act="ai-forget">${icon('trash', 16)} Forget corrections</button>` : ''}
      <button class="set-row as-btn" data-act="ai-models" ${ok ? '' : 'disabled'}><span>Browse available models<small class="muted">Live list from NVIDIA</small></span>${icon('chevR', 18)}</button>
      <p class="muted small">With cloud AI on, photos and Coach messages (including diary details Coach looks up) are sent to NVIDIA through your proxy. The key is never included in backups.</p>
    </section>`;
}

export async function render(el, params = []) {
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
      <div class="card-head"><h3>${icon('target', 18)} Food grades</h3><span class="grade-strip" aria-hidden="true">${GRADES.map(g => `<span class="grade grade-${g.letter.toLowerCase()} xs">${g.letter}</span>`).join('')}</span></div>
      <p class="muted small">Every food gets an A–F diet-fit grade for <b>${esc(planLabel(s.profile.goal, s.profile.diet))}</b>. It weighs protein against your target, calorie density, fibre, sugar, saturated fat, salt, processing level and additives. Change your goal or diet style in the calculator above and grades update.</p>
      <label class="set-row"><span>Show grades<small class="muted">Badges in food lists and the diary</small></span><input type="checkbox" class="switch" data-toggle="grades" ${s.grades !== false ? 'checked' : ''}></label>
      <button class="set-row as-btn" data-act="grades-help"><span>How grades work<small class="muted">Scoring, caps and additive ratings</small></span>${icon('chevR', 18)}</button>
    </section>

    ${aiCard(s)}

    <section class="card">
      <div class="card-head"><h3>${icon('cpu', 18)} On-device AI</h3><span class="badge ${cached ? 'badge-ok' : ''}">${cached ? 'Ready offline' : 'Not downloaded'}</span></div>
      <p class="muted small">The offline fallback for Snap AI. MobileCLIP-S0 runs locally via WebAssembly and photos are never uploaded. It identifies the food and the app injects verified nutrition data, then refines with portion, cooking-method and calorie-density passes.</p>
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
  el.querySelectorAll('[data-ai]').forEach(inp => inp.addEventListener('change', async () => {
    const key = inp.dataset.ai;
    let v = inp.value.trim();
    if (key === 'endpoint' && v && !/^https?:\/\//i.test(v)) v = `https://${v}`;
    if (key === 'endpoint' || key === 'apiKey') resetQuirks();
    await saveSettings({ ai: { [key]: v } });
    toast(key === 'apiKey' ? 'API key saved on this device' : 'AI settings saved', { icon: 'check' });
  }));
  if (params[0] === 'ai') requestAnimationFrame(() => el.querySelector('#ai-settings')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
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
    const aiSeg = e.target.closest('[data-aiseg] [data-v]');
    if (aiSeg) { await saveSettings({ ai: { [aiSeg.closest('[data-aiseg]').dataset.aiseg]: aiSeg.dataset.v } }); haptic(8); return; }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'ai-guide') openAISetupGuide();
    if (act === 'ai-forget') { await saveSettings({ ai: { corrections: [] } }); toast('Corrections cleared', { icon: 'check' }); }
    if (act === 'ai-models') openModelBrowser();
    if (act === 'ai-test') {
      const btn = e.target.closest('button');
      const msg = el.querySelector('.ai-test-msg');
      btn.disabled = true;
      msg.className = 'small ai-test-msg muted';
      msg.textContent = 'Testing… (big models can take up to a minute on the first call)';
      try {
        const r = await testConnection();
        msg.className = 'small ai-test-msg ok-text';
        msg.innerHTML = `${icon('check', 14)} Connected in ${(r.ms / 1000).toFixed(1)} s · ${r.models} models available${r.missing.length ? ` · <span class="warn-text">not in catalog: ${esc(r.missing.join(', '))}</span>` : ''}`;
        haptic(20);
      } catch (err) {
        msg.className = 'small ai-test-msg warn-text';
        msg.textContent = err.message;
      } finally { btn.disabled = false; }
    }
    if (act === 'targets') openTargetsSheet();
    if (act === 'grades-help') openGradesHelp();
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

async function openModelBrowser() {
  const sheet = openSheet({ title: 'NVIDIA models', full: true, html: '<p class="muted small">Loading the live catalog…</p>' });
  try {
    const ids = await listModels();
    const known = new Map(MODELS.map(m => [m.id, m]));
    const draw = () => {
      const cur = getSettings().ai;
      sheet.body.innerHTML = `
        <p class="muted small">${ids.length} models on your account. Known chat models are first; embedding, safety and code models won't work as Coach.</p>
        <div class="model-list">${[...ids].sort((a, b) => known.has(b) - known.has(a)).map(id => {
          const m = known.get(id);
          return `<div class="model-opt ${id === cur.agentModel || id === cur.visionModel ? 'on' : ''}">
            <span class="mo-main"><b>${esc(m?.label || id)}</b><small>${esc(m ? `${m.note}` : id)}</small></span>
            <span class="row gap-sm">
              <button class="btn sm ${id === cur.agentModel ? 'primary' : 'soft'}" data-coach="${esc(id)}">Coach</button>
              <button class="btn sm ${id === cur.visionModel ? 'primary' : 'soft'}" data-vision="${esc(id)}">Photos</button>
            </span>
          </div>`;
        }).join('')}</div>`;
    };
    draw();
    sheet.body.addEventListener('click', async e => {
      const c = e.target.closest('[data-coach]'), v = e.target.closest('[data-vision]');
      if (c) await saveSettings({ ai: { agentModel: c.dataset.coach } });
      if (v) await saveSettings({ ai: { visionModel: v.dataset.vision } });
      if (c || v) { haptic(8); draw(); }
    });
  } catch (err) {
    sheet.body.innerHTML = `<p class="warn-text">${esc(err.message)}</p>`;
  }
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

function openGradesHelp() {
  const s = getSettings();
  openSheet({
    title: 'How food grades work',
    html: `
      <div class="help">
        <p>Each food starts at <b>50</b>. Factors add or take away points, and the total sets the grade. Grades judge the food per 100 g, not the portion, and they're personalised to <b>${esc(planLabel(s.profile.goal, s.profile.diet))}</b>.</p>
        <ul class="help-grades">${GRADES.map(g => `<li><span class="grade grade-${g.letter.toLowerCase()}">${g.letter}</span><span><b>${g.min}+</b> · ${esc(g.verdict)}</span></li>`).join('')}</ul>
        <h4>What's scored</h4>
        <ul class="help-list">
          <li><b>Protein</b>: share of calories from protein vs your target. Counts more on a high-protein diet, a cut or a bulk.</li>
          <li><b>Calorie density</b>: low-calorie, filling foods score well on a cut; dense foods with good protein help a bulk. Sugary drinks lose points as liquid calories.</li>
          <li><b>Fibre, sugar, saturated fat and salt</b>: UK traffic-light thresholds. Natural sugar in whole fruit, veg and plain dairy isn't penalised; juice is.</li>
          <li><b>Diet style</b>: net carbs for keto, carb share for low-carb, starchy fuel for endurance.</li>
          <li><b>Processing</b>: NOVA group from Open Food Facts, estimated from ingredients, or typical for generic foods.</li>
          <li><b>Additives</b>: each rated by concern, using regulator decisions (UK FSA, EFSA, US FDA, IARC) and major studies.</li>
          <li><b>Extras</b>: oily fish scores up; processed meat, alcohol, trans fats and deep-frying score down.</li>
        </ul>
        <h4>Caps</h4>
        <p>Ultra-processed food can't get an A. A high-concern additive or processed meat caps a food at C. Alcohol, trans fats or several high-concern additives cap it at D.</p>
        <h4>Additive ratings</h4>
        <ul class="help-tiers">${TIERS.map((t, i) => `<li>${tierDot(i)}<b>${t.label}</b></li>`).join('')}</ul>
        <p class="muted small">Barcode-scanned products use their real label. Generic foods use typical values, so scan the actual product for an exact grade. Paste the ingredients into a custom food to check its additives too.</p>
        <p class="muted small">Grades are a guide to help you choose, not medical advice.</p>
      </div>`,
  });
}
