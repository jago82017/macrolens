// Diary: day navigation strip, per-meal entries, copy-from-yesterday, day summary.

import { getSettings, getEntries, getEntriesRange, addEntries, deleteEntry, addEntry, allFoods, saveMeal, mealItemFrom } from '../store.js';
import { sum } from '../nutrition.js';
import { pbar, animate, toast, openSheet } from '../ui.js';
import { icon } from '../icons.js';
import { esc, fmt, todayKey, addDays, startOfWeek, parseKey, relDay, isKey, MEALS, haptic } from '../util.js';
import { openAddFood } from '../sheets/addfood.js';
import { openFoodDetail, foodFromEntry, thumb, badge } from '../sheets/food.js';
import { checkGoals } from '../celebrate.js';
import { gradeFood, gradeBadge, withGradeData, averageGrade } from '../grade.js';

let suppressClickUntil = 0; // swallow the click that follows a long-press delete

export async function render(el, [dateParam]) {
  const date = isKey(dateParam) ? dateParam : todayKey();
  const tg = getSettings().targets;
  const wk = startOfWeek(date);
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(wk, i));
  const settings = getSettings();
  const [entries, weekEntries, prevEntries, foods] = await Promise.all([
    getEntries(date),
    getEntriesRange(weekDays[0], weekDays[6]),
    getEntries(addDays(date, -1)),
    settings.grades === false ? [] : allFoods(),
  ]);
  // Diet-fit grade per entry: the entry's own nutrition plus additives/NOVA from the stored food.
  const foodById = new Map(foods.map(f => [f.id, f]));
  const grades = new Map(settings.grades === false ? [] : entries.map(e => [e.id, gradeFood(withGradeData(foodFromEntry(e), foodById.get(e.foodId)), settings)]));
  const dayGrade = averageGrade(entries.map(e => ({ grade: grades.get(e.id), kcal: e.kcal })));
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
      ${dayGrade ? `<div class="ds-grade">${gradeBadge(dayGrade)}<div><b>Food quality: ${esc(dayGrade.verdict.replace(/ for your diet$/, ''))}</b><small class="muted">Calorie-weighted average of ${date === today ? 'today\'s' : 'this day\'s'} foods · ${dayGrade.score}/100</small></div></div>` : ''}
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
          ${list.length || prev.length ? `<button class="btn-icon ghost meal-more" data-menu="${m.id}" aria-label="${m.name} options">${icon('more', 18)}</button>` : ''}
          <button class="btn-icon primary-soft" data-add="${m.id}" aria-label="Add to ${m.name}">${icon('plus', 18)}</button>
        </header>
        ${list.length ? `<ul class="list">${list.map(e => `
          <li class="entry-wrap">
            <span class="entry-bg" aria-hidden="true">${icon('trash', 18)} Delete</span>
            <div class="entry" data-entry="${e.id}">
              <div class="li-thumb">${thumb(e)}</div>
              <div class="li-main">
                <div class="li-title">${esc(e.name)}</div>
                <div class="li-sub">${e.source === 'ai' || e.source === 'quick' ? badge(e.source) + ' ' : ''}${esc(amountText(e))} · ${macroLine(e)}</div>
              </div>
              ${grades.get(e.id) ? `<div class="li-grade">${gradeBadge(grades.get(e.id))}</div>` : ''}
              <div class="li-end"><b>${fmt(e.kcal)}</b><small>kcal</small></div>
            </div>
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
    const menu = e.target.closest('[data-menu]');
    if (menu) return openMealMenu(menu.dataset.menu);
    const copy = e.target.closest('[data-copy]');
    if (copy) return copyYesterday(copy.dataset.copy);
    const row = e.target.closest('[data-entry]');
    if (row) {
      const entry = entries.find(x => x.id === row.dataset.entry);
      if (entry) openFoodDetail(foodFromEntry(entry), { entry });
    }
  };

  async function copyYesterday(meal) {
    const src = prevEntries.filter(x => x.meal === meal);
    const added = await addEntries(src.map(({ id, createdAt, ...rest }) => ({ ...rest, date })));
    haptic(15);
    toast(`Copied ${src.length} item${src.length > 1 ? 's' : ''}`, {
      icon: 'copy', action: 'Undo',
      onAction: async () => { for (const a of added) await deleteEntry(a.id); },
    });
    checkGoals(date);
  }

  function openMealMenu(mealId) {
    const meal = MEALS.find(m => m.id === mealId);
    const list = entries.filter(x => x.meal === mealId);
    const prev = prevEntries.filter(x => x.meal === mealId);
    const kcal = sum(list).kcal;
    const sheet = openSheet({
      title: `${meal.emoji} ${meal.name}`,
      html: `<div class="meal-menu">
        ${list.length ? `
          <div class="field"><label class="label">Save as a meal you can add in one tap</label>
            <div class="row gap-sm"><input class="input" data-mealname maxlength="40" value="${esc(defaultMealName(meal, list))}"><button class="btn primary" data-save>${icon('star', 16)} Save</button></div>
            <p class="muted small">${list.length} item${list.length > 1 ? 's' : ''} · ${fmt(kcal)} kcal. Find it at the top of Add food → Search.</p>
          </div>` : ''}
        ${prev.length ? `<button class="btn soft block" data-copyprev>${icon('copy', 16)} Copy yesterday's ${meal.name.toLowerCase()} (${prev.length})</button>` : ''}
        ${list.length ? `<button class="btn ghost block danger-text" data-clear>${icon('trash', 16)} Clear ${meal.name.toLowerCase()}</button>` : ''}
      </div>`,
    });
    sheet.el.addEventListener('click', async e => {
      if (e.target.closest('[data-save]')) {
        const name = sheet.el.querySelector('[data-mealname]').value.trim() || defaultMealName(meal, list);
        await saveMeal({ name, emoji: meal.emoji, items: list.map(mealItemFrom) });
        sheet.close();
        haptic(20);
        toast(`Saved “${name}”`, { icon: 'star' });
      } else if (e.target.closest('[data-copyprev]')) {
        sheet.close();
        copyYesterday(mealId);
      } else if (e.target.closest('[data-clear]')) {
        sheet.close();
        for (const x of list) await deleteEntry(x.id);
        haptic(20);
        toast(`Cleared ${meal.name.toLowerCase()}`, { icon: 'trash', action: 'Undo', onAction: () => addEntries(list) });
      }
    });
  }

  // Gestures: swipe an entry left to delete it, or long-press it.
  let pressTimer, swipe = null;
  const removeEntry = async id => {
    const removed = await deleteEntry(id);
    if (removed) toast(`Removed ${removed.name}`, { action: 'Undo', icon: 'trash', onAction: () => addEntry(removed) });
  };
  el.onpointerdown = e => {
    const row = e.target.closest('[data-entry]');
    if (!row || e.button > 0) return;
    swipe = { row, wrap: row.parentElement, x: e.clientX, y: e.clientY, dx: 0, active: false };
    pressTimer = setTimeout(async () => {
      swipe = null;
      suppressClickUntil = Date.now() + 900;
      haptic(30);
      removeEntry(row.dataset.entry);
    }, 650);
  };
  el.onpointermove = e => {
    if (Math.abs(e.movementY) > 3 || Math.abs(e.movementX) > 3) clearTimeout(pressTimer);
    if (!swipe) return;
    const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
    if (!swipe.active) {
      if (dx < -10 && Math.abs(dx) > Math.abs(dy) * 1.4) {
        swipe.active = true;
        swipe.row.classList.add('swiping');
        try { swipe.row.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
      } else if (Math.abs(dy) > 10) { swipe = null; return; }
    }
    if (swipe.active) {
      swipe.dx = Math.min(0, dx);
      swipe.row.style.transform = `translateX(${swipe.dx}px)`;
      const armed = swipe.dx < -96;
      if (armed !== swipe.wrap.classList.contains('armed')) haptic(8);
      swipe.wrap.classList.toggle('armed', armed);
    }
  };
  el.onpointerup = el.onpointercancel = () => {
    clearTimeout(pressTimer);
    const s = swipe;
    swipe = null;
    if (!s?.active) return;
    suppressClickUntil = Date.now() + 400;
    s.row.classList.remove('swiping');
    if (s.dx < -96) {
      s.row.style.transform = 'translateX(-110%)';
      s.wrap.classList.add('gone');
      haptic(20);
      setTimeout(() => removeEntry(s.row.dataset.entry), 380);
    } else {
      s.row.style.transform = '';
      s.wrap.classList.remove('armed');
    }
  };
  el.onpointerleave = () => clearTimeout(pressTimer);
}

function defaultMealName(meal, list) {
  const names = list.slice(0, 2).map(e => e.name.split(/[,(]/)[0].trim());
  return list.length <= 2 ? names.join(' & ') : `My ${meal.name.toLowerCase()}`;
}

function amountText(e) {
  if (e.source === 'quick') return 'Quick add';
  if (!e.unit || e.unit === 'g') return `${fmt(e.grams)} g`;
  if (e.unit === 'oz') return `${fmt(e.qty, 2)} oz`;
  return `${fmt(e.qty, 2)} × ${e.unit} (${fmt(e.grams)} g)`;
}
