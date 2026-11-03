// Small shared helpers: DOM, dates, numbers, haptics.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// ---- Dates (local-time YYYY-MM-DD keys, never UTC) ----
const pad = n => String(n).padStart(2, '0');
export const dateKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayKey = () => dateKey(new Date());

export function parseKey(k) {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(k, n) {
  const d = parseKey(k);
  d.setDate(d.getDate() + n);
  return dateKey(d);
}

export function startOfWeek(k) {
  const d = parseKey(k);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
  return dateKey(d);
}

export function fmtDate(k, opts = { weekday: 'long', day: 'numeric', month: 'short' }) {
  return parseKey(k).toLocaleDateString(undefined, opts);
}

export function relDay(k) {
  const t = todayKey();
  if (k === t) return 'Today';
  if (k === addDays(t, -1)) return 'Yesterday';
  if (k === addDays(t, 1)) return 'Tomorrow';
  return fmtDate(k, { weekday: 'short', day: 'numeric', month: 'short' });
}

export const isKey = k => /^\d{4}-\d{2}-\d{2}$/.test(k || '');

// ---- Numbers ----
export const round = (n, d = 0) => { const f = 10 ** d; return Math.round((+n || 0) * f) / f; };
export const fmt = (n, d = 0) => round(n, d).toLocaleString(undefined, { maximumFractionDigits: d });
export const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
export const pct = (v, max) => (max > 0 ? v / max : 0);

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- Haptics (toggled from settings) ----
export const flags = { haptics: true, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches };
export function haptic(pattern = 10) {
  if (!flags.haptics) return;
  try { navigator.vibrate?.(pattern); } catch { /* unsupported */ }
}

// ---- Meals ----
export const MEALS = [
  { id: 'breakfast', name: 'Breakfast', emoji: '🌅' },
  { id: 'lunch', name: 'Lunch', emoji: '☀️' },
  { id: 'dinner', name: 'Dinner', emoji: '🌙' },
  { id: 'snacks', name: 'Snacks', emoji: '🍿' },
];
export const mealName = id => MEALS.find(m => m.id === id)?.name || 'Snacks';

export function mealForNow(d = new Date()) {
  const h = d.getHours() + d.getMinutes() / 60;
  if (h < 10.5) return 'breakfast';
  if (h < 14.5) return 'lunch';
  if (h >= 17 && h < 21.5) return 'dinner';
  return 'snacks';
}

export function greeting(d = new Date()) {
  const h = d.getHours();
  if (h < 5) return 'Good night';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

export function capitalize(s) {
  s = String(s || '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function bytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${round(n / 1024 ** i, i ? 1 : 0)} ${u[i]}`;
}
