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
  const [entries, weights, dayRecs] = await Promise.all([getEntriesRange(days[0], days[6]), getWeights(), getDaysRange(days[0], days[6])]);

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
      <div class="card-head"><h3>Body weight</h3><button class="btn soft sm" data-weight>${icon('plus', 16)} Log</button></div>
      ${weightChart(weights, imp)}
    </section>

    <section class="card insights">
      <div class="card-head"><h3>${icon('bulb', 18)} Insights</h3></div>
      <ul>${insights({ days, totals, logged, tg, entries, dayRecs, avg, onTarget, proteinHits }).map(i => `<li>${i}</li>`).join('')}</ul>
    </section>
    <div class="bottom-space"></div>`;

  animate(el);
  el.onclick = e => { if (e.target.closest('[data-weight]')) openWeightSheet(weights, imp); };
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

function weightChart(weights, imp) {
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
    <span class="muted small">${recent.length > 1 ? `${fmt(conv(last.kg) - conv(first.kg), 1)} ${unit} since ${fmtDate(first.date, { day: 'numeric', month: 'short' })}` : ''}</span></div>`;
  if (recent.length < 2) return head;
  const W = 340, H = 140, pad = 12;
  const vals = recent.map(w => conv(w.kg));
  const min = Math.min(...vals) - 0.5, max = Math.max(...vals) + 0.5;
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
