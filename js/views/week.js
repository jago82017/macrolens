// Weekly overview: calorie chart vs target, adherence heat-strip, macro split, weight trend, insights.

import { getSettings, getEntriesRange, getWeights, getDaysRange, logWeight, deleteWeight, saveSettings } from '../store.js';
import { sum, macroSplit, kgToLb, lbToKg } from '../nutrition.js';
import { animate, openSheet, toast } from '../ui.js';
import { icon } from '../icons.js';
import { esc, fmt, round, todayKey, addDays, startOfWeek, parseKey, isKey, fmtDate } from '../util.js';

const within = (v, t, tol) => t > 0 && v >= t * (1 - tol) && v <= t * (1 + tol);

export async function render(el, [param]) {
  const s = getSettings();
  const tg = s.targets;
  const imp = s.units === 'imperial';
  const today = todayKey();
  const ws = startOfWeek(isKey(param) ? param : today);
  const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
  const [entries, weights, dayRecs, allEntries, allDays] = await Promise.all([
    getEntriesRange(days[0], days[6]), getWeights(), getDaysRange(days[0], days[6]),
    getEntriesRange('0000-01-01', '9999-12-31'), getDaysRange('0000-01-01', '9999-12-31'),
  ]);
  const achievements = computeAchievements(allEntries, allDays, weights, tg);

  const totals = days.map(d => sum(entries.filter(e => e.date === d)));
  const logged = totals.map((t, i) => (t.kcal > 0 ? i : -1)).filter(i => i >= 0);
  const n = logged.length;
  const avg = k => (n ? logged.reduce((acc, i) => acc + totals[i][k], 0) / n : 0);
  const onTarget = logged.filter(i => within(totals[i].kcal, tg.kcal, 0.1)).length;
  const proteinHits = logged.filter(i => totals[i].protein >= tg.protein * 0.95).length;
  const isCurrent = ws === startOfWeek(today);
  const range = `${fmtDate(days[0], { day: 'numeric', month: 'short' })} – ${fmtDate(days[6], { day: 'numeric', month: 'short' })}`;

  el.innerHTML = `
    <header class="topbar">
      <div><p class="eyebrow">Weekly overview</p><h1>${isCurrent ? 'This week' : esc(range)}</h1></div>
      <div class="week-nav">
        <a class="btn-icon soft" href="#/week/${addDays(ws, -7)}" aria-label="Previous week">${icon('chevL', 18)}</a>
        <a class="btn-icon soft ${isCurrent ? 'disabled' : ''}" href="#/week/${addDays(ws, 7)}" aria-label="Next week">${icon('chevR', 18)}</a>
      </div>
    </header>
    ${isCurrent ? `<p class="muted small range-sub">${esc(range)}</p>` : ''}

    <section class="stat-grid">
      ${stat('flame', 'Avg calories', n ? fmt(avg('kcal')) : '—', n ? `${avg('kcal') <= tg.kcal ? fmt(tg.kcal - avg('kcal')) + ' under' : fmt(avg('kcal') - tg.kcal) + ' over'} target` : 'No data yet', 'kcal')}
      ${stat('target', 'On target', `${onTarget}<small>/${n || 0}</small>`, 'days within ±10%', 'brand')}
      ${stat('trophy', 'Avg protein', n ? `${fmt(avg('protein'))}<small>g</small>` : '—', `target hit ${proteinHits}/${n || 0} days`, 'protein')}
      ${stat('calendar', 'Logged', `${n}<small>/7</small>`, 'days this week', 'fiber')}
    </section>

    <section class="card">
      <div class="card-head"><h3>Calories</h3><span class="legend"><i class="lg-target"></i>Target ${fmt(tg.kcal)}</span></div>
      ${calorieChart(days, totals, tg.kcal, today)}
    </section>

    <section class="card">
      <div class="card-head"><h3>Macro adherence</h3><span class="muted small">% of daily target</span></div>
      ${heatStrip(days, totals, tg)}
    </section>

    <section class="card">
      <div class="card-head"><h3>Average macro split</h3></div>
      ${n ? splitDonut(avg, tg) : `<p class="empty">Log some food to see your macro split.</p>`}
    </section>

    <section class="card">
      <div class="card-head"><h3>Body weight</h3><div class="row gap-sm"><button class="btn ghost sm" data-goal>${icon('target', 16)} Goal</button><button class="btn soft sm" data-weight>${icon('plus', 16)} Log</button></div></div>
      ${weightChart(weights, imp, s.profile.goalWeightKg)}
    </section>

    <section class="card">
      <div class="card-head"><h3>${icon('medal', 18)} Achievements</h3><span class="muted small">${achievements.filter(a => a.done).length}/${achievements.length}</span></div>
      <div class="badge-shelf">${achievements.map(a => `<div class="achv ${a.done ? '' : 'locked'} ${a.isNew ? 'new' : ''}" title="${esc(a.desc)}"><b>${a.emoji}</b><small>${esc(a.title)}</small></div>`).join('')}</div>
    </section>

    <section class="card insights">
      <div class="card-head"><h3>${icon('bulb', 18)} Insights</h3></div>
      <ul>${insights({ days, totals, logged, tg, entries, dayRecs, avg, onTarget, proteinHits }).map(i => `<li>${i}</li>`).join('')}</ul>
    </section>
    <div class="bottom-space"></div>`;

  animate(el);
  el.onclick = e => {
    if (e.target.closest('[data-weight]')) openWeightSheet(weights, imp);
    if (e.target.closest('[data-goal]')) openGoalSheet(weights, imp);
    const a = e.target.closest('.achv');
    if (a) toast(a.title, { icon: 'medal' });
  };
}

// ---------- Achievements (derived from the user's own data) ----------
const SEEN_KEY = 'ml-achv-seen';
function bestStreak(dates) {
  const sorted = [...dates].sort();
  let best = 0, run = 0, prev = null;
  for (const d of sorted) {
    run = prev && addDays(prev, 1) === d ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return best;
}

function computeAchievements(entries, days, weights, tg) {
  const byDay = new Map();
  for (const e of entries) {
    if (!byDay.has(e.date)) byDay.set(e.date, []);
    byDay.get(e.date).push(e);
  }
  const totals = [...byDay.values()].map(list => sum(list));
  const count = fn => totals.filter(fn).length;
  const streak = bestStreak(byDay.keys());
  const list = [
    { id: 'first', emoji: '🌱', title: 'First log', desc: 'Log your first food', done: entries.length > 0 },
    { id: 'streak7', emoji: '🔥', title: '7-day streak', desc: 'Log food 7 days in a row', done: streak >= 7 },
    { id: 'streak30', emoji: '☄️', title: '30-day streak', desc: 'Log food 30 days in a row', done: streak >= 30 },
    { id: 'bullseye', emoji: '🎯', title: 'Bullseye', desc: 'Finish a day within 5% of your calorie target', done: count(t => within(t.kcal, tg.kcal, 0.05)) > 0 },
    { id: 'perfect', emoji: '🏆', title: 'Perfect day', desc: 'Calories and every macro on target in one day', done: count(t => within(t.kcal, tg.kcal, 0.05) && within(t.protein, tg.protein, 0.1) && within(t.carbs, tg.carbs, 0.1) && within(t.fat, tg.fat, 0.1)) > 0 },
    { id: 'protein10', emoji: '💪', title: 'Protein pro', desc: 'Hit your protein target on 10 days', done: count(t => t.protein >= tg.protein) >= 10 },
    { id: 'fiber7', emoji: '🥦', title: 'Fiber friend', desc: 'Hit your fiber target on 7 days', done: count(t => t.fiber >= tg.fiber) >= 7 },
    { id: 'water7', emoji: '💧', title: 'Hydrated', desc: 'Reach your water goal on 7 days', done: days.filter(d => d.water >= tg.water).length >= 7 },
    { id: 'snap10', emoji: '📸', title: 'Snap happy', desc: 'Log 10 foods from photos', done: entries.filter(e => e.source === 'ai').length >= 10 },
    { id: 'coach10', emoji: '🤖', title: 'Delegator', desc: 'Let Coach log 10 foods for you', done: entries.filter(e => e.via === 'coach').length >= 10 },
    { id: 'weigh10', emoji: '⚖️', title: 'Weigh-in habit', desc: 'Record 10 weigh-ins', done: weights.length >= 10 },
    { id: 'century', emoji: '💯', title: 'Century', desc: 'Log 100 foods', done: entries.length >= 100 },
  ];
  let seen = [];
  try { seen = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]'); } catch { /* storage unavailable */ }
  for (const a of list) a.isNew = a.done && !seen.includes(a.id);
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(list.filter(a => a.done).map(a => a.id))); } catch { /* ignore */ }
  return list;
}

// ---------- Goal weight ----------
// Least-squares slope (kg/day) over the last ~3 weeks of weigh-ins.
function weightTrend(weights) {
  const recent = weights.filter(w => w.date >= addDays(weights.at(-1)?.date || todayKey(), -21));
  if (recent.length < 3) return null;
  const t0 = parseKey(recent[0].date).getTime();
  const pts = recent.map(w => [(parseKey(w.date).getTime() - t0) / 864e5, w.kg]);
  if (pts.at(-1)[0] < 5) return null;
  const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const num = pts.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0);
  const den = pts.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
  return den ? num / den : null;
}

function goalSummary(weights, goalKg, imp) {
  if (!goalKg || !weights.length) return '';
  const conv = kg => (imp ? kgToLb(kg) : kg);
  const unit = imp ? 'lb' : 'kg';
  const last = weights.at(-1).kg;
  const start = weights[0].kg;
  const diff = goalKg - last;
  const progress = start === goalKg ? 1 : Math.max(0, Math.min(1, (start - last) / (start - goalKg)));
  const slope = weightTrend(weights);
  let eta;
  if (Math.abs(diff) < 0.3) eta = `🎉 You've reached your goal`;
  else if (slope == null) eta = 'Log a few more weigh-ins to see your projected date';
  else if (Math.sign(slope) !== Math.sign(diff) || Math.abs(slope) < 0.005) eta = 'Your recent trend isn\'t moving toward the goal yet';
  else {
    const daysLeft = Math.round(diff / slope);
    eta = `At this pace: around <b>${esc(fmtDate(addDays(todayKey(), daysLeft), { day: 'numeric', month: 'short', year: 'numeric' }))}</b> (${daysLeft < 14 ? `${daysLeft} days` : `${Math.round(daysLeft / 7)} weeks`})`;
  }
  return `
    <div class="goal-row"><span>Goal <b>${fmt(conv(goalKg), 1)} ${unit}</b> · ${fmt(Math.abs(conv(last) - conv(goalKg)), 1)} ${unit} to go</span><span class="muted small">${Math.round(progress * 100)}%</span></div>
    <div class="goal-bar"><span style="width:0" data-w="${(progress * 100).toFixed(1)}%"></span></div>
    <p class="muted small" style="margin-top:6px">${eta}</p>`;
}

function openGoalSheet(weights, imp) {
  const unit = imp ? 'lb' : 'kg';
  const cur = getSettings().profile.goalWeightKg;
  const sheet = openSheet({
    title: 'Goal weight',
    html: `
      <div class="field"><label class="label">Target weight (${unit})</label><input class="input input-xl" type="number" inputmode="decimal" step="0.1" name="goal" value="${cur ? round(imp ? kgToLb(cur) : cur, 1) : ''}"></div>
      <p class="muted small">Macrolens projects when you'll get there from your last three weeks of weigh-ins.</p>`,
    footer: `${cur ? `<button class="btn ghost danger-text" data-clear>Remove</button>` : ''}<button class="btn primary grow" data-save>Save goal</button>`,
  });
  sheet.el.addEventListener('click', async e => {
    if (e.target.closest('[data-clear]')) { await saveSettings({ profile: { goalWeightKg: null } }); sheet.close(); return; }
    if (!e.target.closest('[data-save]')) return;
    const v = parseFloat(sheet.el.querySelector('[name="goal"]').value);
    if (!(v > 20 && v < 700)) { toast('Enter a valid weight', { icon: 'info' }); return; }
    await saveSettings({ profile: { goalWeightKg: round(imp ? lbToKg(v) : v, 1) } });
    sheet.close();
    toast('Goal saved', { icon: 'target' });
  });
}

function stat(ic, label, value, sub, tone) {
  return `<div class="card stat tone-${tone}"><span class="stat-ico">${icon(ic, 16)}</span><span class="muted small">${label}</span><b>${value}</b><small class="muted">${sub}</small></div>`;
}

function calorieChart(days, totals, target, today) {
  const W = 340, H = 200, top = 22, bottom = 26, h = H - top - bottom;
  const max = Math.max(target * 1.3, ...totals.map(t => t.kcal)) || 1;
  const slot = W / 7, bw = 26;
  const y = v => top + h - (v / max) * h;
  const bars = totals.map((t, i) => {
    const v = t.kcal;
    const x = i * slot + (slot - bw) / 2;
    const bh = Math.max(v > 0 ? 6 : 0, (v / max) * h);
    const cls = !v ? 'empty' : v > target * 1.1 ? 'over' : v >= target * 0.9 ? 'hit' : 'under';
    const d = parseKey(days[i]);
    return `<a href="#/diary/${days[i]}" class="bar-link">
      <rect class="bar-bg" x="${x}" y="${top}" width="${bw}" height="${h}" rx="9"/>
      <rect class="bar ${cls}" x="${x}" y="${top + h - bh}" width="${bw}" height="${bh}" rx="9" style="--d:${i * 60}ms"/>
      ${v ? `<text class="bar-val" x="${x + bw / 2}" y="${top + h - bh - 6}" text-anchor="middle">${v >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v)}</text>` : ''}
      <text class="bar-lbl ${days[i] === today ? 'today' : ''}" x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${d.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 2)}</text>
    </a>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Calories per day">
    <defs><linearGradient id="bar-grad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--brand-2)"/><stop offset="1" stop-color="var(--brand)"/></linearGradient></defs>
    ${bars}
    <line class="target-line" x1="0" x2="${W}" y1="${y(target)}" y2="${y(target)}"/>
  </svg>`;
}

function heatStrip(days, totals, tg) {
  const rows = [['protein', 'Protein'], ['carbs', 'Carbs'], ['fat', 'Fat'], ['fiber', 'Fiber']];
  return `<div class="heat">
    <div class="heat-row heat-head"><span></span>${days.map(d => `<span>${parseKey(d).toLocaleDateString(undefined, { weekday: 'narrow' })}</span>`).join('')}</div>
    ${rows.map(([k, name]) => `
      <div class="heat-row">
        <span class="heat-name" style="color:var(--${k})">${name}</span>
        ${totals.map(t => {
          const p = tg[k] ? t[k] / tg[k] : 0;
          const ok = k === 'protein' || k === 'fiber' ? p >= 0.95 : within(t[k], tg[k], 0.1);
          return `<span class="heat-cell ${ok ? 'ok' : ''}" style="--c:var(--${k});--a:${t.kcal ? Math.min(1, 0.12 + p * 0.75) : 0}" title="${Math.round(p * 100)}%">${t.kcal ? (ok ? icon('check', 12) : Math.round(p * 100)) : ''}</span>`;
        }).join('')}
      </div>`).join('')}
  </div>`;
}

function splitDonut(avg, tg) {
  const a = { protein: avg('protein'), carbs: avg('carbs'), fat: avg('fat') };
  const sp = macroSplit(a), tsp = macroSplit(tg);
  const r = 52, c = 2 * Math.PI * r;
  let off = 0;
  const segs = ['protein', 'carbs', 'fat'].map(k => {
    const len = sp[k] * c;
    const seg = `<circle r="${r}" cx="70" cy="70" fill="none" stroke="var(--${k})" stroke-width="18" stroke-dasharray="${Math.max(0, len - 3)} ${c}" stroke-dashoffset="${-off}" transform="rotate(-90 70 70)"/>`;
    off += len;
    return seg;
  }).join('');
  return `<div class="donut-wrap">
    <svg viewBox="0 0 140 140" class="donut"><circle r="${r}" cx="70" cy="70" fill="none" stroke="var(--track)" stroke-width="18"/>${segs}
      <text x="70" y="66" text-anchor="middle" class="donut-num">${fmt(avg('kcal'))}</text><text x="70" y="84" text-anchor="middle" class="donut-lbl">avg kcal</text></svg>
    <div class="donut-legend">
      ${['protein', 'carbs', 'fat'].map(k => `
        <div><span class="dot" style="background:var(--${k})"></span><b>${Math.round(sp[k] * 100)}%</b><span class="muted">${k[0].toUpperCase() + k.slice(1)} · ${fmt(a[k])}g</span><small class="muted">target ${Math.round(tsp[k] * 100)}%</small></div>`).join('')}
    </div>
  </div>`;
}

function weightChart(weights, imp, goalKg) {
  const recent = weights.slice(-45);
  const conv = kg => (imp ? kgToLb(kg) : kg);
  const unit = imp ? 'lb' : 'kg';
  if (!recent.length) return `<p class="empty">Log your weight to see your trend line.</p>`;
  const last = recent[recent.length - 1];
  const weekAgo = [...recent].reverse().find(w => w.date <= addDays(last.date, -7));
  const first = recent[0];
  const change = weekAgo ? conv(last.kg) - conv(weekAgo.kg) : null;
  const head = `<div class="weight-head"><b>${fmt(conv(last.kg), 1)}<small> ${unit}</small></b>
    ${change != null ? `<span class="pill ${change <= 0 ? 'down' : 'up'}">${change > 0 ? '+' : ''}${fmt(change, 1)} ${unit} / 7 days</span>` : ''}
    <span class="muted small">${recent.length > 1 ? `${fmt(conv(last.kg) - conv(first.kg), 1)} ${unit} since ${fmtDate(first.date, { day: 'numeric', month: 'short' })}` : ''}</span></div>`
    + goalSummary(weights, goalKg, imp);
  if (recent.length < 2) return head;
  const W = 340, H = 140, pad = 12;
  const vals = recent.map(w => conv(w.kg));
  let min = Math.min(...vals) - 0.5, max = Math.max(...vals) + 0.5;
  // Show the goal line when it's reasonably close to the data.
  const goal = goalKg ? conv(goalKg) : null;
  const showGoal = goal != null && goal > min - 6 && goal < max + 6;
  if (showGoal) { min = Math.min(min, goal - 0.5); max = Math.max(max, goal + 0.5); }
  const t0 = parseKey(first.date).getTime(), t1 = parseKey(last.date).getTime() || t0 + 1;
  const pts = recent.map((w, i) => [pad + ((parseKey(w.date).getTime() - t0) / Math.max(1, t1 - t0)) * (W - pad * 2), pad + (1 - (vals[i] - min) / (max - min)) * (H - pad * 2)]);
  // 7-point moving average trend
  const trend = pts.map((p, i) => {
    const win = vals.slice(Math.max(0, i - 3), i + 4);
    const av = win.reduce((a, b) => a + b, 0) / win.length;
    return [p[0], pad + (1 - (av - min) / (max - min)) * (H - pad * 2)];
  });
  const line = trend.map(p => p.map(v => v.toFixed(1)).join(',')).join(' ');
  return `${head}<svg class="chart weight" viewBox="0 0 ${W} ${H}">
    <defs><linearGradient id="w-grad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--brand)" stop-opacity=".35"/><stop offset="1" stop-color="var(--brand)" stop-opacity="0"/></linearGradient></defs>
    <polygon points="${line} ${trend[trend.length - 1][0]},${H} ${trend[0][0]},${H}" fill="url(#w-grad)"/>
    ${showGoal ? `<line class="goal-line" x1="0" x2="${W}" y1="${(pad + (1 - (goal - min) / (max - min)) * (H - pad * 2)).toFixed(1)}" y2="${(pad + (1 - (goal - min) / (max - min)) * (H - pad * 2)).toFixed(1)}"/>` : ''}
    <polyline points="${line}" fill="none" stroke="var(--brand)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    ${pts.map(p => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3" class="w-dot"/>`).join('')}
  </svg>`;
}

function insights({ days, totals, logged, tg, entries, dayRecs, avg, onTarget, proteinHits }) {
  const out = [];
  const n = logged.length;
  if (!n) return ['No food logged this week yet. Scan a barcode or snap a meal to get started.'];
  const a = avg('kcal');
  const diff = a - tg.kcal;
  out.push(Math.abs(diff) < tg.kcal * 0.05
    ? `🎯 You averaged <b>${fmt(a)} kcal</b> — right on your target.`
    : `${diff < 0 ? '📉' : '📈'} You averaged <b>${fmt(a)} kcal</b>, ${fmt(Math.abs(diff))} ${diff < 0 ? 'under' : 'over'} target (≈ ${fmt(Math.abs(diff * 7) / 7700, 2)} kg/week ${diff < 0 ? 'deficit' : 'surplus'}).`);
  out.push(`💪 Protein target reached on <b>${proteinHits} of ${n}</b> logged days${proteinHits < n ? ` — average ${fmt(avg('protein'))} g vs ${tg.protein} g.` : '. Excellent!'}`);
  const best = logged.reduce((b, i) => (Math.abs(totals[i].kcal - tg.kcal) < Math.abs(totals[b].kcal - tg.kcal) ? i : b), logged[0]);
  out.push(`⭐ Closest to target: <b>${fmtDate(days[best], { weekday: 'long' })}</b> with ${fmt(totals[best].kcal)} kcal.`);
  const fiberAvg = avg('fiber');
  if (fiberAvg < tg.fiber * 0.7) out.push(`🌿 Fiber averaged ${fmt(fiberAvg)} g — try adding legumes, berries or whole grains to reach ${tg.fiber} g.`);
  const byFood = new Map();
  for (const e of entries) byFood.set(e.name, (byFood.get(e.name) || 0) + (e.kcal || 0));
  const top = [...byFood.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3);
  if (top.length) out.push(`🍽️ Biggest contributors: ${top.map(([name, k]) => `${esc(name)} (${fmt(k)} kcal)`).join(', ')}.`);
  const water = dayRecs.filter(d => d.water > 0);
  if (water.length) {
    const wAvg = water.reduce((acc, d) => acc + d.water, 0) / water.length;
    out.push(`💧 Water averaged <b>${(wAvg / 1000).toFixed(1)} L</b> on tracked days${wAvg >= tg.water ? ' — well hydrated!' : ` (goal ${(tg.water / 1000).toFixed(1)} L).`}`);
  }
  if (onTarget >= 5) out.push(`🔥 ${onTarget} days on target — that's an elite week.`);
  return out;
}

function openWeightSheet(weights, imp) {
  const unit = imp ? 'lb' : 'kg';
  const conv = kg => (imp ? kgToLb(kg) : kg);
  const last = weights[weights.length - 1];
  const sheet = openSheet({
    title: 'Log body weight',
    html: `
      <div class="grid2">
        <div class="field"><label class="label">Weight (${unit})</label><input class="input input-xl" type="number" inputmode="decimal" step="0.1" name="w" value="${last ? round(conv(last.kg), 1) : ''}"></div>
        <div class="field"><label class="label">Date</label><input class="input" type="date" name="d" value="${todayKey()}" max="${todayKey()}"></div>
      </div>
      <p class="muted small">Tip: weigh in the morning, after the bathroom and before eating, for the most consistent trend.</p>
      ${weights.length ? `<h4 class="sub-head">Recent</h4><ul class="list compact">${weights.slice(-8).reverse().map(w => `
        <li class="row between"><span>${esc(fmtDate(w.date, { weekday: 'short', day: 'numeric', month: 'short' }))}</span><span class="row gap-sm"><b>${fmt(conv(w.kg), 1)} ${unit}</b><button class="btn-icon ghost sm" data-delw="${w.date}" aria-label="Delete">${icon('trash', 14)}</button></span></li>`).join('')}</ul>` : ''}`,
    footer: `<button class="btn primary block lg" data-save>Save weight</button>`,
  });
  sheet.el.addEventListener('click', async e => {
    const del = e.target.closest('[data-delw]');
    if (del) { await deleteWeight(del.dataset.delw); del.closest('li').remove(); return; }
    if (!e.target.closest('[data-save]')) return;
    const v = parseFloat(sheet.el.querySelector('[name="w"]').value);
    const d = sheet.el.querySelector('[name="d"]').value || todayKey();
    if (!(v > 20 && v < 700)) { toast('Enter a valid weight', { icon: 'info' }); return; }
    const kg = imp ? lbToKg(v) : v;
    await logWeight(d, kg);
    if (d === todayKey()) await saveSettings({ profile: { weightKg: round(kg, 1) } });
    sheet.close();
    toast('Weight logged', { icon: 'check' });
  });
}
