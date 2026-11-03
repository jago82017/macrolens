// Dashboard: today's calories ring, macro rings, water, meals, quick actions and a 7-day sparkline.

import { getSettings, getEntries, getDay, getEntriesRange, getStreak, addWater } from '../store.js';
import { sum } from '../nutrition.js';
import { ring, pbar, animate } from '../ui.js';
import { icon } from '../icons.js';
import { esc, fmt, todayKey, addDays, fmtDate, greeting, MEALS, parseKey, haptic } from '../util.js';
import { openAddFood } from '../sheets/addfood.js';
import { checkWater } from '../celebrate.js';
import { installState, promptInstall } from '../install.js';

const MACRO_META = [
  { id: 'protein', name: 'Protein', color: 'var(--protein)' },
  { id: 'carbs', name: 'Carbs', color: 'var(--carbs)' },
  { id: 'fat', name: 'Fat', color: 'var(--fat)' },
];

export async function render(el) {
  const s = getSettings();
  const tg = s.targets;
  const date = todayKey();
  const [entries, day, week, streak] = await Promise.all([
    getEntries(date), getDay(date), getEntriesRange(addDays(date, -6), date), getStreak(),
  ]);
  const t = sum(entries);
  const remaining = tg.kcal - t.kcal;
  const over = remaining < 0;

  const byMeal = Object.fromEntries(MEALS.map(m => [m.id, entries.filter(e => e.meal === m.id)]));
  const days = Array.from({ length: 7 }, (_, i) => addDays(date, i - 6));
  const perDay = days.map(d => sum(week.filter(e => e.date === d)).kcal);
  const maxDay = Math.max(tg.kcal * 1.25, ...perDay);
  const water = day.water || 0;
  const glasses = Math.max(6, Math.round(tg.water / 250));
  const filled = Math.min(glasses, Math.floor(water / 250));

  el.innerHTML = `
    <header class="topbar">
      <div>
        <p class="eyebrow">${esc(fmtDate(date))}</p>
        <h1>${greeting()}${s.name ? `, ${esc(s.name)}` : ''}</h1>
      </div>
      <a class="streak-chip ${streak ? 'on' : ''}" href="#/week" aria-label="${streak} day streak">${icon('flame', 16)}<b>${streak}</b></a>
    </header>

    ${installState.canInstall ? `
      <button class="card install-card" data-install>
        <span class="install-ico">${icon('phone', 22)}</span>
        <span><b>Install Macrolens</b><small>Add it to your home screen. It works offline and feels native.</small></span>
        ${icon('chevR', 18)}
      </button>` : ''}

    <section class="card hero">
      <div class="hero-ring">
        ${ring({
          key: 'dash-kcal', value: t.kcal, max: tg.kcal, size: 210, stroke: 18, color: 'url(#grad-kcal)',
          children: `<span class="hero-num ${over ? 'over' : ''}" data-count="${Math.abs(Math.round(remaining))}" data-count-key="dash-rem">0</span>
                     <span class="hero-lbl">${over ? 'kcal over' : 'kcal left'}</span>`,
        })}
      </div>
      <div class="hero-stats">
        <div><span class="muted small">Eaten</span><b data-count="${Math.round(t.kcal)}" data-count-key="dash-eaten">0</b></div>
        <div class="divider"></div>
        <div><span class="muted small">Target</span><b>${fmt(tg.kcal)}</b></div>
        <div class="divider"></div>
        <div><span class="muted small">Fiber</span><b>${fmt(t.fiber)}<small>/${tg.fiber}g</small></b></div>
      </div>
    </section>

    <section class="macro-grid">
      ${MACRO_META.map(m => {
        const v = t[m.id], goal = tg[m.id], left = goal - v;
        return `<a class="card macro-card" href="#/diary">
          ${ring({ key: `dash-${m.id}`, value: v, max: goal, size: 68, stroke: 8, color: m.color, children: `<span class="macro-pct">${goal ? Math.round((v / goal) * 100) : 0}%</span>` })}
          <div class="macro-name" style="color:${m.color}">${m.name}</div>
          <div class="macro-val"><b>${fmt(v)}</b><span class="muted">/${goal}g</span></div>
          <div class="macro-left muted small">${left >= 0 ? `${fmt(left)}g left` : `${fmt(-left)}g over`}</div>
        </a>`;
      }).join('')}
    </section>

    <section class="quick-actions">
      <button data-quick="scan"><span class="qa-ico scan">${icon('scan', 22)}</span>Scan</button>
      <button data-quick="snap"><span class="qa-ico snap">${icon('sparkles', 22)}</span>Snap AI</button>
      <button data-quick="search"><span class="qa-ico search">${icon('search', 22)}</span>Search</button>
      <button data-quick="quick"><span class="qa-ico quick">${icon('zap', 22)}</span>Quick add</button>
    </section>

    <section class="card water-card">
      <div class="card-head">
        <div class="row gap-sm"><span class="water-ico">${icon('droplet', 18)}</span><div><h3>Water</h3><p class="muted small"><b class="water-amt">${(water / 1000).toFixed(2)}</b> / ${(tg.water / 1000).toFixed(1)} L</p></div></div>
        <div class="row gap-sm">
          <button class="btn-icon soft" data-water="-250" aria-label="Remove 250 ml">${icon('minus', 18)}</button>
          <button class="btn soft sm" data-water="250">${icon('plus', 16)} 250 ml</button>
        </div>
      </div>
      <div class="glasses">${Array.from({ length: glasses }, (_, i) => `<span class="glass ${i < filled ? 'full' : ''}" style="--i:${i}"></span>`).join('')}</div>
    </section>

    <section class="card meals-card">
      <div class="card-head"><h3>Today's meals</h3><a class="link" href="#/diary">Open diary ${icon('chevR', 14)}</a></div>
      ${MEALS.map(m => {
        const list = byMeal[m.id];
        const kcal = sum(list).kcal;
        const names = list.slice(0, 3).map(e => esc(e.name)).join(', ') + (list.length > 3 ? ` +${list.length - 3}` : '');
        return `<div class="meal-row">
          <span class="meal-emoji">${m.emoji}</span>
          <a class="grow" href="#/diary"><b>${m.name}</b><small class="muted">${list.length ? names : 'Nothing logged yet'}</small></a>
          <span class="meal-kcal">${list.length ? `${fmt(kcal)}<small> kcal</small>` : ''}</span>
          <button class="btn-icon soft sm" data-add="${m.id}" aria-label="Add to ${m.name}">${icon('plus', 16)}</button>
        </div>`;
      }).join('')}
    </section>

    <a class="card spark-card" href="#/week">
      <div class="card-head"><h3>Last 7 days</h3><span class="link">Weekly report ${icon('chevR', 14)}</span></div>
      <div class="spark">
        <div class="spark-target" style="bottom:calc(18px + (100% - 18px) * ${(tg.kcal / maxDay).toFixed(3)})"></div>
        ${perDay.map((v, i) => `
          <div class="spark-col ${days[i] === date ? 'today' : ''}">
            <div class="spark-bar-wrap"><div class="spark-bar ${v > tg.kcal * 1.1 ? 'over' : v >= tg.kcal * 0.9 ? 'hit' : ''}" style="height:0" data-h="${(v / maxDay) * 100}%"></div></div>
            <span>${parseKey(days[i]).toLocaleDateString(undefined, { weekday: 'narrow' })}</span>
          </div>`).join('')}
      </div>
    </a>
    <div class="bottom-space"></div>`;

  animate(el);

  el.onclick = async e => {
    const q = e.target.closest('[data-quick]');
    if (q) return openAddFood({ tab: q.dataset.quick });
    const a = e.target.closest('[data-add]');
    if (a) return openAddFood({ meal: a.dataset.add });
    const w = e.target.closest('[data-water]');
    if (w) {
      const before = water;
      const d = await addWater(date, +w.dataset.water);
      haptic(10);
      checkWater(date, before, d.water);
      return;
    }
    if (e.target.closest('[data-install]')) promptInstall();
  };
}
