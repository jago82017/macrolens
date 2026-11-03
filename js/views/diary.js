// Diary: day navigation strip, per-meal entries, copy-from-yesterday, day summary.

import { getSettings, getEntries, getEntriesRange, addEntries, deleteEntry, addEntry } from '../store.js';
import { sum } from '../nutrition.js';
import { pbar, animate, toast } from '../ui.js';
import { icon } from '../icons.js';
import { esc, fmt, todayKey, addDays, startOfWeek, parseKey, relDay, isKey, MEALS, haptic } from '../util.js';
import { openAddFood } from '../sheets/addfood.js';
import { openFoodDetail, foodFromEntry, thumb, badge } from '../sheets/food.js';
import { checkGoals } from '../celebrate.js';

let suppressClickUntil = 0; // swallow the click that follows a long-press delete

export async function render(el, [dateParam]) {
  const date = isKey(dateParam) ? dateParam : todayKey();
  const tg = getSettings().targets;
  const wk = startOfWeek(date);
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(wk, i));
  const [entries, weekEntries, prevEntries] = await Promise.all([
    getEntries(date),
    getEntriesRange(weekDays[0], weekDays[6]),
    getEntries(addDays(date, -1)),
  ]);
  const logged = new Set(weekEntries.map(e => e.date));
  const t = sum(entries);
  const today = todayKey();

  const macroLine = n => `P ${fmt(n.protein)} · C ${fmt(n.carbs)} · F ${fmt(n.fat)}`;

  el.innerHTML = `
    <header class="topbar">
      <div><p class="eyebrow">Food diary</p><h1>${esc(relDay(date))}</h1></div>
      <div class="row gap-sm">
        ${date !== today ? `<a class="btn soft sm" href="#/diary">Today</a>` : ''}
        <label class="btn-icon soft" aria-label="Pick date">${icon('calendar', 18)}<input type="date" class="date-input" value="${date}"></label>
      </div>
    </header>

    <div class="date-strip">
      <a class="btn-icon ghost" href="#/diary/${addDays(wk, -7)}" aria-label="Previous week">${icon('chevL', 18)}</a>
      <div class="days">
        ${weekDays.map(d => {
          const dt = parseKey(d);
          return `<a href="#/diary/${d}" class="day ${d === date ? 'sel' : ''} ${d === today ? 'today' : ''} ${logged.has(d) ? 'logged' : ''}">
            <span>${dt.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 2)}</span><b>${dt.getDate()}</b><i></i></a>`;
        }).join('')}
      </div>
      <a class="btn-icon ghost" href="#/diary/${addDays(wk, 7)}" aria-label="Next week">${icon('chevR', 18)}</a>
    </div>

    <section class="card day-summary">
      <div class="ds-top">
        <div><b class="ds-kcal">${fmt(t.kcal)}</b><span class="muted"> / ${fmt(tg.kcal)} kcal</span></div>
        <span class="muted small">${t.kcal <= tg.kcal ? `${fmt(tg.kcal - t.kcal)} left` : `${fmt(t.kcal - tg.kcal)} over`}</span>
      </div>
      ${pbar(t.kcal, tg.kcal, 'linear-gradient(90deg, var(--brand), var(--brand-2))', 'lg')}
      <div class="ds-macros">
        ${[['protein', 'Protein'], ['carbs', 'Carbs'], ['fat', 'Fat']].map(([k, n]) => `
          <div><div class="row between small"><span style="color:var(--${k})">${n}</span><span class="muted">${fmt(t[k])}/${tg[k]}g</span></div>${pbar(t[k], tg[k], `var(--${k})`)}</div>`).join('')}
      </div>
    </section>

    ${MEALS.map(m => {
      const list = entries.filter(e => e.meal === m.id);
      const n = sum(list);
      const prev = prevEntries.filter(e => e.meal === m.id);
      return `
      <section class="card meal-card" data-meal="${m.id}">
        <header class="meal-head">
          <span class="meal-emoji">${m.emoji}</span>
          <div class="grow"><h3>${m.name}</h3><p class="muted small">${list.length ? `${fmt(n.kcal)} kcal · ${macroLine(n)}` : 'Empty'}</p></div>
          <button class="btn-icon primary-soft" data-add="${m.id}" aria-label="Add to ${m.name}">${icon('plus', 18)}</button>
        </header>
        ${list.length ? `<ul class="list">${list.map(e => `
          <li class="entry" data-entry="${e.id}">
            <div class="li-thumb">${thumb(e)}</div>
            <div class="li-main">
              <div class="li-title">${esc(e.name)}</div>
              <div class="li-sub">${e.source === 'ai' || e.source === 'quick' ? badge(e.source) + ' ' : ''}${esc(amountText(e))} · ${macroLine(e)}</div>
            </div>
            <div class="li-end"><b>${fmt(e.kcal)}</b><small>kcal</small></div>
          </li>`).join('')}</ul>`
          : prev.length ? `<button class="copy-prev" data-copy="${m.id}">${icon('copy', 16)} Copy ${prev.length} item${prev.length > 1 ? 's' : ''} from yesterday</button>` : ''}
      </section>`;
    }).join('')}
    <div class="bottom-space"></div>`;

  animate(el);

  el.querySelector('.date-input').addEventListener('change', e => { if (e.target.value) location.hash = `#/diary/${e.target.value}`; });

  el.onclick = async e => {
    if (Date.now() < suppressClickUntil) return;
    const add = e.target.closest('[data-add]');
    if (add) return openAddFood({ date, meal: add.dataset.add });
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      const meal = copy.dataset.copy;
      const src = prevEntries.filter(x => x.meal === meal);
      const added = await addEntries(src.map(({ id, createdAt, ...rest }) => ({ ...rest, date })));
      haptic(15);
      toast(`Copied ${src.length} item${src.length > 1 ? 's' : ''}`, {
        icon: 'copy', action: 'Undo',
        onAction: async () => { for (const a of added) await deleteEntry(a.id); },
      });
      checkGoals(date);
      return;
    }
    const row = e.target.closest('[data-entry]');
    if (row) {
      const entry = entries.find(x => x.id === row.dataset.entry);
      if (entry) openFoodDetail(foodFromEntry(entry), { entry });
    }
  };

  // Long-press an entry to delete quickly.
  let pressTimer;
  el.onpointerdown = e => {
    const row = e.target.closest('[data-entry]');
    if (!row) return;
    pressTimer = setTimeout(async () => {
      suppressClickUntil = Date.now() + 900;
      haptic(30);
      const removed = await deleteEntry(row.dataset.entry);
      toast(`Removed ${removed.name}`, { action: 'Undo', icon: 'trash', onAction: () => addEntry(removed) });
    }, 650);
  };
  el.onpointerup = el.onpointercancel = el.onpointerleave = () => clearTimeout(pressTimer);
  el.onpointermove = e => { if (Math.abs(e.movementY) > 3 || Math.abs(e.movementX) > 3) clearTimeout(pressTimer); };
}

function amountText(e) {
  if (e.source === 'quick') return 'Quick add';
  if (!e.unit || e.unit === 'g') return `${fmt(e.grams)} g`;
  if (e.unit === 'oz') return `${fmt(e.qty, 2)} oz`;
  return `${fmt(e.qty, 2)} × ${e.unit} (${fmt(e.grams)} g)`;
}
