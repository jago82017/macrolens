// Target-completion celebrations: confetti physics + a badge overlay, fired once per goal per day.

import { getSettings, getEntries, getDay, saveDay, getStreak } from './store.js';
import { sum } from './nutrition.js';
import { todayKey, fmt, haptic, flags, sleep } from './util.js';

// ---------- Confetti ----------
const COLORS = ['#8B7CFF', '#FF6B8B', '#3CC8F0', '#FFC24B', '#4ADE9B', '#ffffff'];
let canvas, ctx, particles = [], raf = 0;

function ensureCanvas() {
  if (canvas) return;
  canvas = document.createElement('canvas');
  canvas.id = 'confetti';
  document.body.appendChild(canvas);
  ctx = canvas.getContext('2d');
  const resize = () => {
    const dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  addEventListener('resize', resize);
}

export function confetti({ count = 140, x = 0.5, y = 0.62, spread = 75, power = 1 } = {}) {
  if (flags.reducedMotion) return;
  ensureCanvas();
  const ox = innerWidth * x, oy = innerHeight * y;
  for (let i = 0; i < count; i++) {
    const angle = (-90 + (Math.random() - 0.5) * spread * 2) * (Math.PI / 180);
    const speed = (9 + Math.random() * 9) * power;
    particles.push({
      x: ox, y: oy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      w: 6 + Math.random() * 6,
      h: 8 + Math.random() * 8,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.35,
      tilt: Math.random() * Math.PI,
      color: COLORS[(Math.random() * COLORS.length) | 0],
      shape: Math.random() < 0.25 ? 'circle' : 'rect',
      life: 0,
      ttl: 140 + Math.random() * 60,
    });
  }
  if (!raf) raf = requestAnimationFrame(tick);
}

function tick() {
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  particles = particles.filter(p => p.life < p.ttl && p.y < innerHeight + 40);
  for (const p of particles) {
    p.life++;
    p.vx *= 0.985;
    p.vy = p.vy * 0.985 + 0.32;
    p.x += p.vx + Math.sin(p.life / 12) * 0.6;
    p.y += p.vy;
    p.rot += p.vr;
    p.tilt += 0.08;
    const alpha = Math.min(1, (p.ttl - p.life) / 30);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.fillStyle = p.color;
    if (p.shape === 'circle') { ctx.beginPath(); ctx.arc(0, 0, p.w / 2.4, 0, Math.PI * 2); ctx.fill(); }
    else ctx.fillRect(-p.w / 2, -p.h / 2 * Math.abs(Math.cos(p.tilt)), p.w, p.h * Math.abs(Math.cos(p.tilt)));
    ctx.restore();
  }
  if (particles.length) raf = requestAnimationFrame(tick);
  else { raf = 0; ctx.clearRect(0, 0, innerWidth, innerHeight); }
}

// ---------- Badge overlay ----------
function showBadge({ emoji, title, sub, accent = 'var(--brand)' }) {
  return new Promise(resolve => {
    const el = document.createElement('div');
    el.className = 'celebrate';
    el.innerHTML = `
      <div class="celebrate-card" style="--accent:${accent}">
        <div class="celebrate-burst"></div>
        <div class="celebrate-emoji">${emoji}</div>
        <h3>${title}</h3>
        <p>${sub}</p>
        <button class="btn primary sm">Nice!</button>
      </div>`;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      el.classList.remove('show');
      setTimeout(() => { el.remove(); resolve(); }, 350);
    };
    el.addEventListener('click', close);
    setTimeout(close, 4200);
  });
}

export async function celebrate(goal) {
  haptic([30, 50, 30, 50, 80]);
  confetti({ count: goal.big ? 220 : 140, power: goal.big ? 1.2 : 1 });
  if (goal.big) setTimeout(() => { confetti({ x: 0.15, y: 0.8, count: 80 }); confetti({ x: 0.85, y: 0.8, count: 80 }); }, 300);
  await showBadge(goal);
}

const within = (v, t, tol) => t > 0 && v >= t * (1 - tol) && v <= t * (1 + tol);
const STREAK_MILESTONES = [3, 7, 14, 30, 50, 100, 200, 365];

// Called after any diary change; only today's progress is celebrated.
export async function checkGoals(date) {
  if (date !== todayKey()) return;
  const s = getSettings();
  if (!s.celebrations) return;
  const tg = s.targets;
  const [entries, day] = await Promise.all([getEntries(date), getDay(date)]);
  if (!entries.length) return;
  const t = sum(entries);
  const done = day.celebrated || {};
  const goals = [];

  // Logging-streak milestones (the first log of a milestone day).
  const streak = await getStreak();
  if (STREAK_MILESTONES.includes(streak) && !done[`streak${streak}`]) {
    goals.push({
      id: `streak${streak}`, emoji: streak >= 30 ? '☄️' : '🔥', title: `${streak}-day streak!`,
      sub: streak >= 30 ? 'That\'s a real habit now. Seriously impressive.' : `${streak} days of logging in a row. Keep the fire going.`,
      big: streak >= 7, accent: '#ff7a3d',
    });
  }

  if (!done.protein && tg.protein && t.protein >= tg.protein) {
    goals.push({ id: 'protein', emoji: '💪', title: 'Protein target smashed!', sub: `${fmt(t.protein)} g of ${tg.protein} g — your muscles thank you.`, accent: 'var(--protein)' });
  }
  if (!done.kcal && within(t.kcal, tg.kcal, 0.05)) {
    goals.push({ id: 'kcal', emoji: '🎯', title: 'Calorie target hit!', sub: `${fmt(t.kcal)} of ${fmt(tg.kcal)} kcal — right in the zone.`, accent: 'var(--kcal)' });
  }
  if (!done.fiber && tg.fiber && t.fiber >= tg.fiber) {
    goals.push({ id: 'fiber', emoji: '🌿', title: 'Fiber goal reached', sub: `${fmt(t.fiber)} g of fiber today. Gut happy.`, accent: 'var(--fiber)' });
  }
  if (!done.perfect && within(t.kcal, tg.kcal, 0.05) && within(t.protein, tg.protein, 0.1) && within(t.carbs, tg.carbs, 0.1) && within(t.fat, tg.fat, 0.1)) {
    goals.push({ id: 'perfect', emoji: '🏆', title: 'Perfect macro day!', sub: `Calories and every macro within target.${streak > 1 ? ` ${streak}-day logging streak 🔥` : ''}`, big: true, accent: 'var(--fat)' });
  }
  if (!goals.length) return;

  day.celebrated = { ...done };
  for (const g of goals) day.celebrated[g.id] = true;
  await saveDay(day);
  for (const g of goals) { await celebrate(g); await sleep(150); }
}

export async function checkWater(date, before, after) {
  const s = getSettings();
  if (!s.celebrations || date !== todayKey()) return;
  const target = s.targets.water;
  if (!target || before >= target || after < target) return;
  const day = await getDay(date);
  if (day.celebrated?.water) return;
  day.celebrated = { ...(day.celebrated || {}), water: true };
  await saveDay(day);
  celebrate({ emoji: '💧', title: 'Hydration goal complete', sub: `${(after / 1000).toFixed(1)} L today. Stay fresh!`, accent: 'var(--water)' });
}
