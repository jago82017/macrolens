// App shell: boot, hash router, theme, live re-rendering, service worker + updates.

import { openDB, requestPersistence } from './db.js';
import { loadSettings, getSettings, on } from './store.js';
import { icon } from './icons.js';
import { toast, sheetsOpen } from './ui.js';
import { debounce, todayKey, isKey } from './util.js';
import { openAddFood } from './sheets/addfood.js';
import { openOnboarding } from './sheets/onboarding.js';
import { installState } from './install.js';
import * as dashboard from './views/dashboard.js';
import * as diary from './views/diary.js';
import * as week from './views/week.js';
import * as profile from './views/profile.js';

const ROUTES = { dashboard, diary, week, profile };
const view = document.getElementById('view');
let current = { name: null, params: [] };
let renderSeq = 0;
let renderedDay = todayKey();

function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  return { name: parts[0] || 'dashboard', params: parts.slice(1) };
}

async function route() {
  let { name, params } = parseHash();
  if (name === 'add') {
    // Deep link (manifest shortcuts): #/add/scan, #/add/snap, #/add/search.
    // If it arrives while sheets are open (app already running), start clean rather than stacking.
    if (sheetsOpen()) { location.reload(); return; }
    history.replaceState(null, '', '#/dashboard');
    name = 'dashboard';
    const tab = ['scan', 'snap', 'search', 'create', 'quick'].includes(params[0]) ? params[0] : 'search';
    setTimeout(() => openAddFood({ tab }), 350);
    params = [];
  }
  if (!ROUTES[name]) name = 'dashboard';
  const changed = name !== current.name;
  current = { name, params };
  document.querySelectorAll('.tabbar [data-route]').forEach(a => {
    const on = a.dataset.route === name;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  await render(changed);
  if (changed) window.scrollTo({ top: 0 });
}

async function render(enter = false) {
  const seq = ++renderSeq;
  const el = document.createElement('div');
  el.className = 'view-inner';
  try {
    await ROUTES[current.name].render(el, current.params);
  } catch (e) {
    console.error(e);
    el.innerHTML = `<div class="card error-card"><b>Something went wrong</b><p class="muted small">${String(e.message || e)}</p></div>`;
  }
  if (seq !== renderSeq) return;
  renderedDay = todayKey();
  if (enter) el.classList.add('enter');
  view.replaceChildren(el);
}

const rerender = debounce(() => render(false), 40);

// ---------- Theme ----------
const darkMQ = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const t = getSettings().theme;
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  const dark = t === 'dark' || (t === 'system' && darkMQ.matches);
  document.querySelector('meta[name="theme-color"]').content = dark ? '#0c0d12' : '#f4f5fa';
  try { localStorage.setItem('ml-theme', t); } catch { /* storage unavailable */ }
}
darkMQ.addEventListener('change', applyTheme);

// ---------- Tab bar ----------
function buildTabbar() {
  const nav = document.querySelector('.tabbar');
  nav.innerHTML = `
    <a href="#/dashboard" data-route="dashboard">${icon('home', 22)}<span>Home</span></a>
    <a href="#/diary" data-route="diary">${icon('book', 22)}<span>Diary</span></a>
    <button class="fab" aria-label="Add food">${icon('plus', 28)}</button>
    <a href="#/week" data-route="week">${icon('chart', 22)}<span>Week</span></a>
    <a href="#/profile" data-route="profile">${icon('user', 22)}<span>Profile</span></a>`;
  nav.querySelector('.fab').addEventListener('click', () => {
    const date = current.name === 'diary' && isKey(current.params[0]) ? current.params[0] : todayKey();
    openAddFood({ date });
  });
}

// ---------- Service worker ----------
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  // Local development: skip the cache-first worker unless explicitly requested with ?sw
  if (location.hostname === 'localhost' && !new URLSearchParams(location.search).has('sw')) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('./sw.js').then(reg => {
    const prompt = () => toast('A new version of Macrolens is ready', {
      action: 'Update', icon: 'refresh', duration: 20000,
      onAction: () => reg.waiting?.postMessage({ type: 'SKIP_WAITING' }),
    });
    if (reg.waiting && hadController) prompt();
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      sw?.addEventListener('statechange', () => { if (sw.state === 'installed' && navigator.serviceWorker.controller) prompt(); });
    });
    // Check for updates when the app comes back to the foreground.
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(e => console.warn('SW registration failed', e));
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
}

// ---------- Boot ----------
async function boot() {
  await openDB();
  await loadSettings();
  applyTheme();
  buildTabbar();

  addEventListener('hashchange', route);
  on('entries', rerender);
  on('day', rerender);
  on('weights', rerender);
  on('install', rerender);
  on('foods', () => current.name === 'profile' && rerender());
  on('settings', () => { applyTheme(); rerender(); });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && todayKey() !== renderedDay && !sheetsOpen()) rerender();
  });
  addEventListener('offline', () => toast("You're offline — your diary still works", { icon: 'wifiOff' }));
  addEventListener('online', () => toast('Back online', { icon: 'check', duration: 1800 }));

  await route();
  document.body.classList.add('ready');

  if (!getSettings().onboarded) openOnboarding();
  else if (installState.installed) requestPersistence();
  registerSW();
}

boot().catch(err => {
  console.error(err);
  document.body.classList.add('ready');
  view.innerHTML = `<div class="card error-card"><b>Macrolens couldn't start</b><p class="muted small">${String(err.message || err)}. Private browsing can block storage — try a normal window.</p></div>`;
});
