// First-run welcome + automatic target setup.

import { openSheet } from '../ui.js';
import { icon } from '../icons.js';
import { getSettings, saveSettings } from '../store.js';
import { calcForm } from './calculator.js';
import { requestPersistence } from '../db.js';
import { confetti } from '../celebrate.js';

export function openOnboarding() {
  const s = getSettings();
  const sheet = openSheet({
    full: true,
    dismissible: false,
    className: 'onboard',
    html: `
      <div class="ob-step" data-step="1">
        <div class="ob-hero">
          <div class="ob-logo"><img src="icons/icon-192.png" alt="" width="84" height="84"></div>
          <h1>Welcome to <span class="grad-text">Macrolens</span></h1>
          <p class="muted">Track calories and macros with barcode scanning, global food databases and an AI that runs on your phone.</p>
        </div>
        <ul class="ob-features">
          <li><span class="f-ico scan">${icon('scan', 20)}</span><div><b>Scan any barcode</b><small>Open Food Facts + USDA, with custom foods for anything missing</small></div></li>
          <li><span class="f-ico snap">${icon('sparkles', 20)}</span><div><b>Snap a meal, ask Coach</b><small>NVIDIA AI estimates photos and logs food for you, or keep photos on-device</small></div></li>
          <li><span class="f-ico week">${icon('chart', 20)}</span><div><b>See your week</b><small>Trends, adherence, insights and celebrations</small></div></li>
          <li><span class="f-ico safe">${icon('shield', 20)}</span><div><b>Yours, offline</b><small>Everything is stored on this device</small></div></li>
        </ul>
        <div class="field"><label class="label">What should we call you?</label><input class="input" data-name placeholder="Your name (optional)" maxlength="30" value="${s.name || ''}"></div>
        <button class="btn primary block lg" data-next>Set up my targets ${icon('chevR', 18)}</button>
      </div>
      <div class="ob-step" data-step="2" hidden>
        <h2>Your daily targets</h2>
        <p class="muted small">Tell us a bit about you and we'll calculate calories and macros automatically. You can fine-tune them any time in Profile.</p>
        <div class="field">
          <label class="label">Units</label>
          <div class="seg" data-units>
            <button type="button" data-u="metric" class="${s.units === 'metric' ? 'active' : ''}">Metric (kg, cm)</button>
            <button type="button" data-u="imperial" class="${s.units === 'imperial' ? 'active' : ''}">Imperial (lb, ft)</button>
          </div>
        </div>
        <div class="calc-host"></div>
        <button class="btn link-btn block" data-skip>Skip — use default targets</button>
      </div>`,
  });

  let units = s.units;
  const finish = async (patch = {}) => {
    const name = sheet.el.querySelector('[data-name]').value.trim();
    await saveSettings({ ...patch, name, units, onboarded: true });
    requestPersistence();
    sheet.dismissible = true;
    sheet.close();
    setTimeout(() => confetti({ count: 120 }), 300);
  };
  const mountCalc = () => calcForm(sheet.el.querySelector('.calc-host'), {
    profile: getSettings().profile,
    units,
    applyLabel: "Let's go",
    onApply: (profile, t) => finish({ profile, targets: { kcal: t.kcal, protein: t.protein, carbs: t.carbs, fat: t.fat, fiber: t.fiber, water: t.water } }),
  });

  sheet.el.addEventListener('click', e => {
    if (e.target.closest('[data-next]')) {
      sheet.el.querySelector('[data-step="1"]').hidden = true;
      sheet.el.querySelector('[data-step="2"]').hidden = false;
      sheet.body.scrollTop = 0;
      mountCalc();
    }
    const u = e.target.closest('[data-u]');
    if (u) {
      units = u.dataset.u;
      sheet.el.querySelectorAll('[data-u]').forEach(b => b.classList.toggle('active', b === u));
      mountCalc();
    }
    if (e.target.closest('[data-skip]')) finish();
  });
}
