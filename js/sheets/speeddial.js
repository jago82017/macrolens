// Radial quick-add menu that springs out of the + button.

import { openSheet, closeAllSheets } from '../ui.js';
import { icon } from '../icons.js';
import { haptic } from '../util.js';
import { openAddFood } from './addfood.js';

const ACTIONS = [
  { id: 'scan', label: 'Scan', icon: 'scan', cls: 'd-scan' },
  { id: 'snap', label: 'Snap AI', icon: 'sparkles', cls: 'd-snap' },
  { id: 'search', label: 'Search', icon: 'search', cls: 'd-search' },
  { id: 'quick', label: 'Quick', icon: 'zap', cls: 'd-quick' },
  { id: 'coach', label: 'Coach', icon: 'message', cls: 'd-coach' },
];

export function openSpeedDial({ date } = {}) {
  const fab = document.querySelector('.tabbar .fab');
  const r = fab.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const radius = Math.min(128, innerWidth / 2 - 46);
  const angles = [-168, -128, -90, -52, -12];
  const items = ACTIONS.map((a, i) => {
    const rad = (angles[i] * Math.PI) / 180;
    return { ...a, x: Math.round(Math.cos(rad) * radius), y: Math.round(Math.sin(rad) * radius) };
  });
  haptic(12);
  const sheet = openSheet({
    className: 'dial',
    html: `
      <div class="dial-items" style="--cx:${cx}px;--cy:${cy}px">
        ${items.map((a, i) => `
          <button class="dial-item" data-act="${a.id}" style="--i:${i};--x:${a.x}px;--y:${a.y}px">
            <span class="dial-ico ${a.cls}">${icon(a.icon, 22)}</span><span class="dial-lbl">${a.label}</span>
          </button>`).join('')}
        <button class="dial-close" data-close aria-label="Close menu">${icon('plus', 28)}</button>
      </div>`,
  });
  sheet.el.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    haptic(8);
    const act = b.dataset.act;
    closeAllSheets().then(() => {
      if (act === 'coach') location.hash = '#/coach';
      else openAddFood({ date, tab: act });
    });
  });
  return sheet;
}
