// Motion layer: direction-aware page transitions, staggered entrances, tap ripples, tab indicator.

import { flags } from './util.js';

// ---------- Tap ripples ----------
const RIPPLE = '.btn, .btn-icon, .chip, .food-row, .entry, .qa-ico, .meal-row, .sugg-chip, .set-row.as-btn, .tabbar a, .cand, .day, .fit-item, .dial-ico, .meal-pick';

export function initRipples() {
  if (flags.reducedMotion) return;
  document.addEventListener('pointerdown', e => {
    const el = e.target.closest(RIPPLE);
    if (!el || el.disabled || e.button > 0) return;
    const r = el.getBoundingClientRect();
    const d = Math.max(r.width, r.height) * 2.2;
    const s = document.createElement('span');
    s.className = 'ripple';
    s.style.cssText = `width:${d}px;height:${d}px;left:${e.clientX - r.left - d / 2}px;top:${e.clientY - r.top - d / 2}px`;
    el.appendChild(s);
    setTimeout(() => s.remove(), 650);
  }, { passive: true });
}

// ---------- Page transitions ----------
const ORDER = ['dashboard', 'diary', 'coach', 'week', 'profile'];

export function stagger(el) {
  [...el.children].slice(0, 12).forEach((c, i) => c.style.setProperty('--i', i));
  el.classList.add('stagger');
}

// Swap the view's content; when the route changed, slide in the direction of travel.
export function swapView(view, el, from, to) {
  const changed = from && from !== to;
  if (!changed) { view.replaceChildren(el); return; }
  stagger(el);
  const commit = () => { view.replaceChildren(el); window.scrollTo({ top: 0 }); };
  if (!document.startViewTransition || flags.reducedMotion || document.visibilityState !== 'visible') { commit(); return; }
  const a = ORDER.indexOf(from), b = ORDER.indexOf(to);
  const root = document.documentElement;
  root.dataset.navDir = b >= a ? 'forward' : 'back';
  const t = document.startViewTransition(commit);
  // Chrome skips (rejects) transitions when the page is hidden or another one starts; the DOM still updates.
  t.ready.catch(() => {});
  t.finished.catch(() => {}).finally(() => { delete root.dataset.navDir; });
}

// ---------- Tab bar indicator ----------
export function moveTabPill(nav) {
  const pill = nav.querySelector('.tab-pill');
  const active = nav.querySelector('a.active');
  if (!pill) return;
  if (!active) { pill.style.opacity = '0'; return; }
  pill.style.opacity = '1';
  pill.style.width = `${active.offsetWidth - 8}px`;
  pill.style.transform = `translateX(${active.offsetLeft + 4}px)`;
}
