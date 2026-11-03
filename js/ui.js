// UI primitives: bottom sheets (with Android back-button support), toasts, confirm, rings, count-up numbers.

import { icon } from './icons.js';
import { esc, flags } from './util.js';

// ---------- Bottom sheets ----------
const stack = [];
let ignorePops = 0;
let popWaiters = [];

export function openSheet({ title = '', html = '', footer = '', className = '', full = false, onMount, onClose, dismissible = true } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  wrap.innerHTML = `
    <div class="sheet-backdrop"></div>
    <section class="sheet ${full ? 'sheet-full' : ''} ${className}" role="dialog" aria-modal="true" ${title ? `aria-label="${esc(title)}"` : ''}>
      <div class="sheet-grab" aria-hidden="true"><span></span></div>
      ${title ? `<header class="sheet-head"><h2>${title}</h2><button class="btn-icon ghost" data-close aria-label="Close">${icon('x')}</button></header>` : ''}
      <div class="sheet-body">${html}</div>
      ${footer ? `<footer class="sheet-foot">${footer}</footer>` : ''}
    </section>`;
  document.body.appendChild(wrap);
  document.body.classList.add('has-sheet');

  const el = wrap.querySelector('.sheet');
  const api = {
    wrap, el,
    body: el.querySelector('.sheet-body'),
    foot: el.querySelector('.sheet-foot'),
    onClose,
    dismissible,
    close: value => closeSheet(api, false, value),
  };
  stack.push(api);
  history.pushState({ mlSheet: stack.length }, '');

  wrap.querySelector('.sheet-backdrop').addEventListener('click', () => api.dismissible && api.close());
  wrap.addEventListener('click', e => { if (e.target.closest('[data-close]')) api.close(); });
  enableDrag(api);
  requestAnimationFrame(() => requestAnimationFrame(() => wrap.classList.add('open')));
  onMount?.(api);
  return api;
}

function closeSheet(api, fromPop, value) {
  const i = stack.indexOf(api);
  if (i < 0) return;
  // Close anything stacked above first.
  while (stack.length - 1 > i) closeSheet(stack[stack.length - 1], fromPop);
  stack.splice(i, 1);
  api.closed = true;
  api.wrap.classList.remove('open');
  api.wrap.classList.add('closing');
  setTimeout(() => api.wrap.remove(), 320);
  if (!stack.length) document.body.classList.remove('has-sheet');
  try { api.onClose?.(value); } catch (e) { console.error(e); }
  if (!fromPop) { ignorePops++; history.back(); }
}

window.addEventListener('popstate', () => {
  if (ignorePops > 0) {
    ignorePops--;
    if (!ignorePops) { popWaiters.forEach(r => r()); popWaiters = []; }
    return;
  }
  const top = stack[stack.length - 1];
  if (top) {
    if (top.dismissible) closeSheet(top, true);
    else history.pushState({ mlSheet: stack.length }, ''); // keep non-dismissible sheet
  }
});

addEventListener('keydown', e => {
  const top = stack[stack.length - 1];
  if (e.key === 'Escape' && top?.dismissible) top.close();
});

export function sheetsOpen() { return stack.length; }

// Close every sheet and resolve once history has settled (safe to navigate afterwards).
export function closeAllSheets() {
  if (!stack.length) return Promise.resolve();
  const n = stack.length;
  while (stack.length) {
    const s = stack.pop();
    s.closed = true;
    s.wrap.classList.remove('open');
    s.wrap.classList.add('closing');
    setTimeout(() => s.wrap.remove(), 320);
    try { s.onClose?.(); } catch (e) { console.error(e); }
  }
  document.body.classList.remove('has-sheet');
  ignorePops++;
  const p = new Promise(r => popWaiters.push(r));
  history.go(-n);
  return p;
}

function enableDrag(api) {
  const handles = [api.el.querySelector('.sheet-grab'), api.el.querySelector('.sheet-head')].filter(Boolean);
  let startY = 0, dy = 0, t0 = 0, dragging = false;
  const move = e => {
    if (!dragging) return;
    dy = Math.max(0, e.clientY - startY);
    api.el.style.transform = `translateY(${dy}px)`;
  };
  const up = () => {
    if (!dragging) return;
    dragging = false;
    api.el.style.transition = '';
    const v = dy / Math.max(1, performance.now() - t0);
    if (api.dismissible && (dy > 140 || v > 0.6)) api.close();
    else api.el.style.transform = '';
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  handles.forEach(h => h.addEventListener('pointerdown', e => {
    if (e.target.closest('button, input, select')) return;
    dragging = true; startY = e.clientY; dy = 0; t0 = performance.now();
    api.el.style.transition = 'none';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }));
}

// ---------- Accessibility: tie each .field label to its control ----------
let labelSeq = 0;
function linkLabels(root) {
  if (!(root instanceof Element)) return;
  root.querySelectorAll('.field > label.label:not([for])').forEach(label => {
    const control = label.parentElement.querySelector('input:not([type="hidden"]), select, textarea');
    if (!control || control.closest('label')) return;
    control.id ||= `fld-${++labelSeq}`;
    label.htmlFor = control.id;
  });
}
new MutationObserver(muts => muts.forEach(m => m.addedNodes.forEach(linkLabels)))
  .observe(document.documentElement, { childList: true, subtree: true });

// ---------- Toasts ----------
export function toast(msg, { action, onAction, icon: ic, duration = 3200, type = '' } = {}) {
  let root = document.getElementById('toasts');
  if (!root) { root = document.createElement('div'); root.id = 'toasts'; document.body.appendChild(root); }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.setAttribute('role', 'status');
  el.innerHTML = `${ic ? icon(ic, 18) : ''}<span>${esc(msg)}</span>${action ? `<button>${esc(action)}</button>` : ''}`;
  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  const remove = () => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); };
  if (action) el.querySelector('button').onclick = () => { onAction?.(); remove(); };
  setTimeout(remove, duration);
  return remove;
}

// ---------- Confirm ----------
export function confirmSheet({ title, message, ok = 'Confirm', danger = false }) {
  return new Promise(resolve => {
    let result = false;
    const s = openSheet({
      title,
      html: `<p class="muted">${message}</p>`,
      footer: `<button class="btn ghost" data-close>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(ok)}</button>`,
      onClose: () => resolve(result),
    });
    s.el.querySelector('[data-ok]').onclick = () => { result = true; s.close(); };
  });
}

// ---------- Progress rings ----------
const lastOffsets = new Map();

export function ring({ key, value, max, size = 120, stroke = 12, color = 'var(--kcal)', children = '', cls = '' }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = max > 0 ? value / max : 0;
  const main = Math.min(Math.max(p, 0), 1);
  const over = Math.min(Math.max(p - 1, 0), 1);
  const mid = size / 2;
  const overKey = key ? `${key}:over` : null;
  const circle = (k, col, frac, extra = '') => {
    const target = c * (1 - frac);
    const from = k && lastOffsets.has(k) ? lastOffsets.get(k) : c;
    if (k) lastOffsets.set(k, target);
    return `<circle class="ring-fill ${extra}" cx="${mid}" cy="${mid}" r="${r}" fill="none" stroke="${col}" stroke-width="${stroke}" stroke-linecap="round"
      stroke-dasharray="${c.toFixed(2)}" style="stroke-dashoffset:${from.toFixed(2)}" data-to="${target.toFixed(2)}" transform="rotate(-90 ${mid} ${mid})"/>`;
  };
  return `<div class="ring ${cls}" style="width:${size}px;height:${size}px">
    <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
      <circle cx="${mid}" cy="${mid}" r="${r}" fill="none" stroke="var(--track)" stroke-width="${stroke}"/>
      ${main > 0 || (key && lastOffsets.has(key)) ? circle(key, color, main) : ''}
      ${over > 0 ? circle(overKey, 'var(--over)', over, 'ring-over') : (overKey && lastOffsets.delete(overKey), '')}
    </svg>
    <div class="ring-center">${children}</div>
  </div>`;
}

// Kick transitions after the markup is in the DOM.
export function animate(root) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    root.querySelectorAll('.ring-fill[data-to]').forEach(el => { el.style.strokeDashoffset = el.dataset.to; });
    root.querySelectorAll('[data-w]').forEach(el => { el.style.width = el.dataset.w; });
    root.querySelectorAll('[data-h]').forEach(el => { el.style.height = el.dataset.h; });
    countUp(root);
  }));
}

const lastNumbers = new Map();
function countUp(root) {
  root.querySelectorAll('[data-count]').forEach(el => {
    const key = el.dataset.countKey || null;
    const to = +el.dataset.count;
    const from = key && lastNumbers.has(key) ? lastNumbers.get(key) : 0;
    if (key) lastNumbers.set(key, to);
    if (flags.reducedMotion || from === to) { el.textContent = Math.round(to).toLocaleString(); return; }
    const t0 = performance.now();
    const dur = 700;
    const step = now => {
      const t = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - t, 3);
      el.textContent = Math.round(from + (to - from) * e).toLocaleString();
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

// Simple horizontal progress bar.
export function pbar(value, max, color, cls = '') {
  const w = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const over = max > 0 && value > max * 1.05;
  return `<div class="pbar ${cls} ${over ? 'is-over' : ''}"><span style="width:0;background:${color}" data-w="${w.toFixed(1)}%"></span></div>`;
}

export function skeletonRows(n = 3) {
  return Array.from({ length: n }, () => `<div class="food-row skel-row"><div class="li-thumb skel"></div><div class="li-main"><div class="skel skel-line"></div><div class="skel skel-line short"></div></div></div>`).join('');
}
