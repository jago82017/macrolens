// Automatic macro calculator form (used in onboarding and Profile).

import { icon } from '../icons.js';
import { esc, fmt, round } from '../util.js';
import { ACTIVITY, GOALS, DIETS, calcTargets, macroSplit, kgToLb, lbToKg, cmToFtIn, ftInToCm } from '../nutrition.js';

export function calcForm(container, { profile, units = 'metric', applyLabel = 'Apply these targets', onApply }) {
  const p = { ...profile };
  const imp = units === 'imperial';
  const fi = cmToFtIn(p.heightCm);

  container.innerHTML = `
    <div class="calc">
      <div class="grid2">
        <div class="field">
          <label class="label">Sex</label>
          <div class="seg" data-k="sex">
            <button type="button" data-v="male" class="${p.sex === 'male' ? 'active' : ''}">Male</button>
            <button type="button" data-v="female" class="${p.sex === 'female' ? 'active' : ''}">Female</button>
          </div>
        </div>
        <div class="field"><label class="label">Age</label><input class="input" type="number" inputmode="numeric" data-f="age" min="13" max="100" value="${p.age}"></div>
      </div>
      <div class="grid2">
        ${imp
          ? `<div class="field"><label class="label">Height</label><div class="row gap-sm"><input class="input" type="number" inputmode="numeric" data-f="ft" value="${fi.ft}" aria-label="feet"><span class="unit">ft</span><input class="input" type="number" inputmode="numeric" data-f="in" value="${fi.in}" aria-label="inches"><span class="unit">in</span></div></div>
             <div class="field"><label class="label">Weight</label><div class="row gap-sm"><input class="input" type="number" inputmode="decimal" data-f="lb" value="${round(kgToLb(p.weightKg), 1)}"><span class="unit">lb</span></div></div>`
          : `<div class="field"><label class="label">Height</label><div class="row gap-sm"><input class="input" type="number" inputmode="decimal" data-f="heightCm" value="${p.heightCm}"><span class="unit">cm</span></div></div>
             <div class="field"><label class="label">Weight</label><div class="row gap-sm"><input class="input" type="number" inputmode="decimal" data-f="weightKg" value="${p.weightKg}"><span class="unit">kg</span></div></div>`}
      </div>

      <div class="field">
        <label class="label">Activity level</label>
        <div class="radio-cards" data-k="activity">
          ${ACTIVITY.map(a => `<button type="button" data-v="${a.v}" class="${+p.activity === a.v ? 'active' : ''}"><b>${a.label}</b><small>${a.desc}</small></button>`).join('')}
        </div>
      </div>

      <div class="field">
        <label class="label">Goal</label>
        <div class="seg seg-lg" data-k="goal">
          ${GOALS.map(g => `<button type="button" data-v="${g.id}" class="${p.goal === g.id ? 'active' : ''}"><span>${g.emoji}</span>${g.label}</button>`).join('')}
        </div>
      </div>

      <div class="field rate-field" ${p.goal === 'maintain' ? 'hidden' : ''}>
        <label class="label">Pace <b class="rate-val"></b></label>
        <input type="range" data-f="rate" min="0.1" max="1" step="0.05" value="${p.rate}">
      </div>

      <div class="field">
        <label class="label">Diet style</label>
        <div class="chips-wrap" data-k="diet">
          ${DIETS.map(d => `<button type="button" class="chip ${p.diet === d.id ? 'active' : ''}" data-v="${d.id}" title="${esc(d.desc)}">${d.label}</button>`).join('')}
        </div>
        <p class="muted small diet-desc"></p>
      </div>

      <div class="calc-result">
        <div class="calc-kcal">
          <div><span class="calc-big" data-r="kcal"></span><span class="muted"> kcal / day</span></div>
          <div class="muted small" data-r="explain"></div>
        </div>
        <div class="split-bar lg" data-r="split"><span class="p"></span><span class="c"></span><span class="f"></span></div>
        <div class="calc-macros">
          <div class="protein"><b data-r="protein"></b><small>Protein</small></div>
          <div class="carbs"><b data-r="carbs"></b><small>Carbs</small></div>
          <div class="fat"><b data-r="fat"></b><small>Fat</small></div>
          <div class="fiber"><b data-r="fiber"></b><small>Fiber</small></div>
        </div>
        ${onApply ? `<button type="button" class="btn primary block lg" data-apply>${icon('check', 18)} ${esc(applyLabel)}</button>` : ''}
      </div>
    </div>`;

  const $ = s => container.querySelector(s);
  let result;

  function read() {
    const v = f => parseFloat(container.querySelector(`[data-f="${f}"]`)?.value);
    p.age = v('age') || p.age;
    if (imp) {
      const ft = v('ft'), inch = v('in') || 0;
      if (ft > 0) p.heightCm = round(ftInToCm(ft, inch), 1);
      if (v('lb') > 0) p.weightKg = round(lbToKg(v('lb')), 1);
    } else {
      if (v('heightCm') > 0) p.heightCm = v('heightCm');
      if (v('weightKg') > 0) p.weightKg = v('weightKg');
    }
    p.rate = v('rate') || p.rate;
  }

  function update() {
    read();
    result = calcTargets(p);
    const rateTxt = imp ? `${round(kgToLb(p.rate), 1)} lb / week` : `${p.rate} kg / week`;
    $('.rate-val').textContent = rateTxt;
    $('.rate-field').hidden = p.goal === 'maintain';
    $('.diet-desc').textContent = DIETS.find(d => d.id === p.diet)?.desc || '';
    $('[data-r="kcal"]').textContent = fmt(result.kcal);
    const change = result.weeklyChangeKg;
    const changeTxt = change ? ` · ${change > 0 ? '+' : ''}${imp ? round(kgToLb(change), 1) + ' lb' : change + ' kg'}/week` : '';
    $('[data-r="explain"]').textContent = `BMR ${fmt(result.bmr)} · TDEE ${fmt(result.tdee)}${changeTxt}`;
    $('[data-r="protein"]').textContent = `${result.protein} g`;
    $('[data-r="carbs"]').textContent = `${result.carbs} g`;
    $('[data-r="fat"]').textContent = `${result.fat} g`;
    $('[data-r="fiber"]').textContent = `${result.fiber} g`;
    const sp = macroSplit(result);
    const bars = $('[data-r="split"]').children;
    bars[0].style.width = `${sp.protein * 100}%`;
    bars[1].style.width = `${sp.carbs * 100}%`;
    bars[2].style.width = `${sp.fat * 100}%`;
  }

  // Assigned (not added) so re-mounting into the same container never stacks handlers.
  container.onclick = e => {
    const b = e.target.closest('button[data-v]');
    if (b) {
      const group = b.closest('[data-k]');
      const k = group.dataset.k;
      p[k] = k === 'activity' ? +b.dataset.v : b.dataset.v;
      group.querySelectorAll('[data-v]').forEach(x => x.classList.toggle('active', x === b));
      update();
      return;
    }
    if (e.target.closest('[data-apply]')) onApply?.({ ...p }, result);
  };
  container.oninput = update;
  update();
  return { get: () => ({ profile: { ...p }, targets: result }) };
}
