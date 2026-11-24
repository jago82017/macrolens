// Coach: chat with an NVIDIA-hosted model that can read and change the diary and food library.

import { agent } from '../agent/agent.js';
import { isConfigured, modelInfo, MODELS, compressImage } from '../cloud.js';
import { getSettings, saveSettings, getEntries } from '../store.js';
import { openSheet, toast, confirmSheet } from '../ui.js';
import { icon } from '../icons.js';
import { esc, haptic, todayKey } from '../util.js';
import { openAISetupGuide } from '../sheets/aisetup.js';
import { voiceSupported, listen } from '../voice.js';
import { sum } from '../nutrition.js';

// The chat keeps its own DOM state; app.js skips data-driven re-renders for this view.
export const keepAlive = true;

let unsub = null;
let draft = '';
let attachments = [];
let stopVoice = null;

// ---------- Markdown-lite (escaped first, then a small safe subset) ----------
function inline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,!?:;]|$)/g, '$1<i>$2</i>');
}
export function md(src) {
  const lines = esc(src || '').split('\n');
  let html = '', list = null, table = [];
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  const flushTable = () => {
    if (!table.length) return;
    const rows = table.map(r => r.replace(/^\s*\||\|\s*$/g, '').split('|').map(c => inline(c.trim())));
    html += `<div class="md-table"><table><thead><tr>${rows[0].map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.slice(1).map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    table = [];
  };
  for (const line of lines) {
    if (/^\s*\|.*\|\s*$/.test(line)) { closeList(); if (!/^\s*\|?[\s:|-]+\|?\s*$/.test(line) || !/-/.test(line)) table.push(line); continue; }
    flushTable();
    let m;
    if ((m = line.match(/^\s*#{1,4}\s+(.*)$/))) { closeList(); html += `<h4>${inline(m[1])}</h4>`; }
    else if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) { if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(m[1])}</li>`; }
    else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; } html += `<li>${inline(m[1])}</li>`; }
    else if (!line.trim()) closeList();
    else { closeList(); html += `<p>${inline(line)}</p>`; }
  }
  closeList();
  flushTable();
  return html;
}

// ---------- Rendering ----------
const STATUS_ICON = { done: 'check', error: 'info', denied: 'x' };

function itemHTML(it) {
  if (it.role === 'user') {
    return `<div class="msg user" data-id="${it.id}">
      ${it.images?.length ? `<div class="msg-imgs">${it.images.map(i => `<img src="${esc(i.thumb || i.dataUrl)}" alt="Attached photo">`).join('')}</div>` : ''}
      ${it.text ? `<div class="bubble">${esc(it.text).replace(/\n/g, '<br>')}</div>` : ''}
    </div>`;
  }
  if (it.role === 'assistant') {
    const empty = !it.text && !it.thought && !it.streaming;
    if (empty) return `<div class="msg bot hidden-msg" data-id="${it.id}"></div>`;
    return `<div class="msg bot ${it.streaming ? 'streaming' : ''}" data-id="${it.id}">
      ${it.thought ? `<details class="thought" ${it.streaming && !it.text ? 'open' : ''}><summary>${icon('bulb', 13)} ${it.streaming && !it.text ? 'Thinking…' : 'Reasoning'}</summary><div class="thought-body">${esc(it.thought).slice(-6000).replace(/\n/g, '<br>')}</div></details>` : ''}
      ${it.text ? `<div class="bubble md">${md(it.text)}</div>` : it.streaming && !it.thought ? `<div class="bubble typing"><i></i><i></i><i></i></div>${it.waiting ? `<small class="wait-note">${esc(modelInfo(it.model).label)} is queued at NVIDIA · ${it.waiting} s</small>` : ''}` : ''}
    </div>`;
  }
  if (it.role === 'tool') {
    const c = it.card || {};
    if (it.status === 'approval') {
      return `<div class="tool-card approval ${it.risk === 'destructive' ? 'danger' : ''}" data-id="${it.id}">
        <div class="tc-head">${icon('shield', 16)}<b>Coach wants to</b></div>
        <p>${esc(it.preview)}</p>
        <div class="row gap-sm"><button class="btn ghost sm" data-deny="${it.id}">Don't</button><button class="btn primary sm grow" data-approve="${it.id}">${icon('check', 15)} Allow</button></div>
      </div>`;
    }
    return `<div class="tool-card ${it.status}" data-id="${it.id}">
      <span class="tc-ico">${it.status === 'running' ? '<span class="spinner xs"></span>' : icon(c.icon || STATUS_ICON[it.status] || 'check', 15)}</span>
      <div class="tc-text"><b>${esc(c.title || it.name)}</b>${c.detail ? `<small>${esc(c.detail)}</small>` : ''}</div>
      ${it.undone ? '<span class="tc-undone">Undone</span>' : it.undoable ? `<button class="tc-undo" data-undo="${it.id}">${icon('undo', 14)} Undo</button>` : it.status === 'done' ? `<span class="tc-ok">${icon('check', 14)}</span>` : ''}
    </div>`;
  }
  if (it.role === 'note') {
    return `<div class="note ${it.error ? 'error' : ''}" data-id="${it.id}">${it.error ? icon('info', 14) : ''}<span>${esc(it.text)}</span>${it.error ? '<button class="link" data-retry>Retry</button>' : ''}</div>`;
  }
  return '';
}

const SUGGESTIONS = [
  { t: 'Log 2 scrambled eggs and a slice of wholemeal toast for breakfast', i: 'plus' },
  { t: 'What should I eat for dinner to hit my protein target?', i: 'target' },
  { t: 'How did I do this week? Anything to improve?', i: 'chart' },
  { t: 'Snap my meal and log it', i: 'camera', attach: true },
  { t: 'Make a custom food from this nutrition label', i: 'edit', attach: true },
  { t: 'Move my last snack to lunch and halve it', i: 'refresh' },
];

async function welcomeHTML() {
  const s = getSettings();
  const t = sum(await getEntries(todayKey()));
  const left = Math.round(s.targets.protein - t.protein);
  return `<div class="coach-welcome">
    <div class="coach-orb lg">${icon('sparkles', 30)}</div>
    <h2>Hi${s.name ? ` ${esc(s.name)}` : ''}, I'm your Coach</h2>
    <p class="muted">I can log food from a message or photo, search your library, fix entries, build custom foods and review your week.${left > 0 ? ` You have <b>${left} g</b> of protein left today.` : ''}</p>
    <div class="sugg">${SUGGESTIONS.map(x => `<button class="sugg-chip" data-sugg="${esc(x.t)}" ${x.attach ? 'data-attach-sugg' : ''}>${icon(x.i, 15)}<span>${esc(x.t)}</span></button>`).join('')}</div>
  </div>`;
}

function setupHTML() {
  return `<div class="coach-setup card">
    <div class="coach-orb lg">${icon('sparkles', 30)}</div>
    <h2>Set up Coach</h2>
    <p class="muted">Coach runs on NVIDIA's free AI models (Kimi, Nemotron and others). Browsers can't talk to NVIDIA directly, so you deploy a tiny free proxy once. It takes about 3 minutes.</p>
    <ol class="setup-steps">
      <li><b>Get a free NVIDIA API key</b><small>build.nvidia.com → sign in → "Get API Key"</small></li>
      <li><b>Deploy the proxy on Cloudflare</b><small>Free Worker, code included in this app</small></li>
      <li><b>Paste the proxy URL</b><small>Profile → AI, then tap Test</small></li>
    </ol>
    <button class="btn primary block lg" data-act="guide">${icon('bulb', 18)} Show me how</button>
    <a class="btn soft block" href="#/profile/ai">${icon('sliders', 18)} Open AI settings</a>
  </div>`;
}

export async function render(el, params = []) {
  await agent.ready;
  unsub?.();
  unsub = null;
  const s = getSettings();
  const info = modelInfo(s.ai.agentModel);

  if (params[0] === 'ask' && params[1]) {
    draft = params[1];
    history.replaceState(null, '', '#/coach');
  }

  el.innerHTML = `
    <div class="coach">
      <header class="topbar coach-top">
        <div><p class="eyebrow">AI Coach</p><h1>Coach</h1></div>
        <div class="row gap-sm">
          <button class="model-chip" data-act="model" title="${esc(info.id)}">${icon(info.vision ? 'sparkles' : 'cpu', 14)}<span>${esc(info.label)}</span>${icon('chevD', 14)}</button>
          <button class="btn-icon soft" data-act="new" aria-label="New chat">${icon('edit', 18)}</button>
        </div>
      </header>
      <div class="chat"></div>
      ${isConfigured() ? `
      <div class="composer">
        <div class="att-row"></div>
        <div class="composer-box">
          <label class="btn-icon ghost attach" aria-label="Attach photo">${icon('camera', 20)}<input type="file" accept="image/*" multiple hidden data-attach></label>
          ${voiceSupported ? `<button class="btn-icon ghost mic" data-act="mic" aria-label="Speak">${icon('mic', 20)}</button>` : ''}
          <textarea rows="1" placeholder="Ask, or tell Coach what you ate…" aria-label="Message Coach"></textarea>
          <button class="send" data-act="send" aria-label="Send">${icon('send', 18)}</button>
        </div>
      </div>` : ''}
    </div>`;

  const chatEl = el.querySelector('.chat');
  const ta = el.querySelector('textarea');
  const sendBtn = el.querySelector('[data-act="send"]');
  const attRow = el.querySelector('.att-row');

  const scrollDown = (smooth = true) => requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }));
  const nearBottom = () => window.innerHeight + window.scrollY > document.documentElement.scrollHeight - 160;

  async function drawAll() {
    if (!isConfigured()) { chatEl.innerHTML = setupHTML(); return; }
    chatEl.innerHTML = agent.items.length ? agent.items.map(itemHTML).join('') : await welcomeHTML();
    scrollDown(false);
  }
  function upsert(it) {
    const html = itemHTML(it);
    const old = chatEl.querySelector(`[data-id="${it.id}"]`);
    if (old) {
      // Keep a reasoning panel the user opened open across streaming updates.
      const det = old.querySelector('details.thought');
      const keepOpen = det?.open && det.dataset.user === '1';
      old.outerHTML = html;
      if (keepOpen) {
        const d = chatEl.querySelector(`[data-id="${it.id}"] details.thought`);
        if (d) { d.open = true; d.dataset.user = '1'; }
      }
    } else {
      chatEl.querySelector('.coach-welcome')?.remove();
      chatEl.insertAdjacentHTML('beforeend', html);
    }
  }
  function setRunning() {
    if (!sendBtn) return;
    sendBtn.classList.toggle('stop', agent.running);
    sendBtn.innerHTML = agent.running ? icon('stop', 16) : icon('send', 18);
    sendBtn.setAttribute('aria-label', agent.running ? 'Stop' : 'Send');
  }
  function drawAttachments() {
    if (!attRow) return;
    attRow.innerHTML = attachments.map((a, i) => `<span class="att"><img src="${a.thumb}" alt=""><button data-unattach="${i}" aria-label="Remove photo">${icon('x', 12)}</button></span>`).join('');
    attRow.hidden = !attachments.length;
  }
  function autosize() {
    if (!ta) return;
    // The view renders detached first; measure only once it's in the document.
    if (!ta.isConnected) { requestAnimationFrame(() => ta.isConnected && autosize()); return; }
    ta.style.height = 'auto';
    if (ta.scrollHeight) ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }

  await drawAll();
  setRunning();
  drawAttachments();
  if (ta) { ta.value = draft; autosize(); }

  unsub = agent.on((type, it) => {
    if (!el.isConnected) return;
    const stick = nearBottom();
    if (type === 'reset') { drawAll(); return; }
    if (type === 'state') { setRunning(); return; }
    if (type === 'remove') { chatEl.querySelector(`[data-id="${it.id}"]`)?.remove(); return; }
    upsert(it);
    if (type === 'update' && it.role === 'tool' && it.status === 'approval') haptic([15, 30, 15]);
    if (stick || type === 'item') scrollDown(type !== 'delta');
  });

  async function send(text) {
    const msg = (text ?? ta?.value ?? '').trim();
    if (!msg && !attachments.length) return;
    const imgs = attachments;
    attachments = [];
    draft = '';
    if (ta) { ta.value = ''; autosize(); }
    drawAttachments();
    haptic(8);
    agent.send(msg, imgs);
  }

  async function attach(files) {
    for (const f of [...files].slice(0, 4 - attachments.length)) {
      try { attachments.push(await compressImage(f, 1024, 0.82)); } catch { toast("Couldn't read that image", { icon: 'info' }); }
    }
    drawAttachments();
    ta?.focus();
  }

  el.querySelector('[data-attach]')?.addEventListener('change', e => { attach(e.target.files); e.target.value = ''; });
  // Remember panels the user expanded themselves (summary clicks), so streaming doesn't collapse them.
  chatEl.addEventListener('click', e => { const d = e.target.closest('summary')?.parentElement; if (d?.classList.contains('thought')) d.dataset.user = d.open ? '0' : '1'; });
  ta?.addEventListener('input', () => { draft = ta.value; autosize(); });
  // While typing on a phone, slide the tab bar away so the keyboard + composer have room.
  ta?.addEventListener('focus', () => document.body.classList.add('coach-typing'));
  ta?.addEventListener('blur', () => setTimeout(() => document.body.classList.remove('coach-typing'), 120));
  ta?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); if (!agent.running) send(); }
  });

  el.onclick = async e => {
    const t = e.target.closest('button, [data-sugg]');
    if (!t) return;
    if (t.dataset.act === 'send') { agent.running ? agent.stop() : send(); return; }
    if (t.dataset.act === 'new') {
      if (!agent.items.length || await confirmSheet({ title: 'Start a new chat?', message: 'The current conversation will be cleared. Your diary changes stay.', ok: 'New chat' })) agent.reset();
      return;
    }
    if (t.dataset.act === 'model') { openModelPicker(); return; }
    if (t.dataset.act === 'mic') {
      if (stopVoice) { stopVoice(); return; }
      const base = ta.value ? `${ta.value.trim()} ` : '';
      t.classList.add('listening');
      haptic(10);
      stopVoice = listen({
        onText: text => { ta.value = base + text; draft = ta.value; autosize(); },
        onEnd: err => {
          t.classList.remove('listening');
          stopVoice = null;
          if (err && err !== 'no-speech' && err !== 'aborted') toast(err === 'not-allowed' ? 'Microphone access is blocked for this app' : `Voice input failed (${err})`, { icon: 'info' });
        },
      });
      return;
    }
    if (t.dataset.act === 'guide') { openAISetupGuide(); return; }
    if (t.dataset.approve) { agent.approve(t.dataset.approve, true); return; }
    if (t.dataset.deny) { agent.approve(t.dataset.deny, false); return; }
    if (t.dataset.undo) { await agent.undo(t.dataset.undo); toast('Undone', { icon: 'undo' }); return; }
    if (t.hasAttribute('data-retry')) { agent.retry(); return; }
    if (t.dataset.unattach != null) { attachments.splice(+t.dataset.unattach, 1); drawAttachments(); return; }
    if (t.dataset.sugg) {
      if (t.hasAttribute('data-attach-sugg')) { if (ta) ta.value = t.dataset.sugg; draft = t.dataset.sugg; el.querySelector('[data-attach]')?.click(); }
      else send(t.dataset.sugg);
    }
  };
}

function openModelPicker() {
  const ai = getSettings().ai;
  const sheet = openSheet({
    title: 'Coach model',
    html: `
      <p class="muted small">Free NVIDIA-hosted models. Vision models can see photos you attach; others hand photos to your vision model (${esc(modelInfo(ai.visionModel).label)}).</p>
      <div class="model-list">${MODELS.map(m => `
        <button class="model-opt ${m.id === ai.agentModel ? 'on' : ''}" data-model="${esc(m.id)}">
          <span class="mo-main"><b>${esc(m.label)}</b><small>${esc(m.note)}</small></span>
          <span class="mo-tags">${m.vision ? `<span class="badge">${icon('image', 11)} Vision</span>` : ''}${m.tools ? `<span class="badge">${icon('zap', 11)} Tools</span>` : ''}</span>
        </button>`).join('')}
      </div>
      <div class="field" style="margin-top:14px">
        <label class="label">Reasoning</label>
        <div class="seg" data-effort>${['fast', 'balanced', 'deep'].map(e => `<button data-e="${e}" class="${ai.effort === e ? 'active' : ''}">${e[0].toUpperCase() + e.slice(1)}</button>`).join('')}</div>
        <p class="muted small">Deeper reasoning is more accurate but slower.</p>
      </div>`,
  });
  sheet.el.addEventListener('click', async e => {
    const m = e.target.closest('[data-model]');
    if (m) {
      await saveSettings({ ai: { agentModel: m.dataset.model } });
      sheet.el.querySelectorAll('[data-model]').forEach(b => b.classList.toggle('on', b === m));
      document.querySelector('.model-chip span') && (document.querySelector('.model-chip span').textContent = modelInfo(m.dataset.model).label);
      haptic(8);
    }
    const ef = e.target.closest('[data-e]');
    if (ef) {
      await saveSettings({ ai: { effort: ef.dataset.e } });
      sheet.el.querySelectorAll('[data-e]').forEach(b => b.classList.toggle('active', b === ef));
    }
  });
}
