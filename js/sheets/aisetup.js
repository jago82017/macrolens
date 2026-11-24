// Step-by-step guide for connecting Coach / cloud Snap AI to NVIDIA through a free Cloudflare Worker.

import { openSheet, toast, closeAllSheets } from '../ui.js';
import { icon } from '../icons.js';
import { esc } from '../util.js';

async function copy(text, what) {
  try { await navigator.clipboard.writeText(text); toast(`${what} copied`, { icon: 'check' }); }
  catch { toast('Copy failed — select and copy it manually', { icon: 'info' }); }
}

export function openAISetupGuide() {
  const origin = location.origin;
  const sheet = openSheet({
    title: 'Connect NVIDIA AI',
    full: true,
    html: `
      <div class="guide">
        <p class="muted">NVIDIA hosts big AI models for free, but browsers aren't allowed to call it directly. A tiny Cloudflare Worker (free) passes requests through. Do this once on any computer or phone.</p>

        <section class="g-step"><span class="g-n">1</span><div>
          <b>Get a free NVIDIA API key</b>
          <p>Open <a class="link" href="https://build.nvidia.com" target="_blank" rel="noopener">build.nvidia.com</a>, sign in, open any model and tap <b>Get API Key</b> → <b>Generate</b>. Copy the key (it starts with <code>nvapi-</code>).</p>
        </div></section>

        <section class="g-step"><span class="g-n">2</span><div>
          <b>Create the proxy Worker</b>
          <p>Open <a class="link" href="https://dash.cloudflare.com" target="_blank" rel="noopener">dash.cloudflare.com</a> (free account) → <b>Workers &amp; Pages</b> → <b>Create</b> → <b>Create Worker</b>. Name it e.g. <code>macrolens-ai</code> and tap <b>Deploy</b>. Then tap <b>Edit code</b>, delete everything, paste this code and tap <b>Deploy</b>.</p>
          <button class="btn soft block" data-copy-code>${icon('copy', 16)} Copy proxy code</button>
          <details class="g-code"><summary>Show code</summary><pre class="code"></pre></details>
        </div></section>

        <section class="g-step"><span class="g-n">3</span><div>
          <b>Add your key to the Worker</b>
          <p>In the Worker go to <b>Settings</b> → <b>Variables and Secrets</b> → <b>Add</b>:</p>
          <ul>
            <li>Type <b>Secret</b>, name <code>NVIDIA_API_KEY</code>, value: your nvapi key.</li>
            <li>Type <b>Text</b>, name <code>ALLOWED_ORIGINS</code>, value: <code>${esc(origin)}</code> <button class="link" data-copy-origin>Copy</button></li>
          </ul>
          <p>Tap <b>Deploy</b>. Your key now lives only in the Worker, and only this app can use it.</p>
        </div></section>

        <section class="g-step"><span class="g-n">4</span><div>
          <b>Connect the app</b>
          <p>Copy the Worker's URL (looks like <code>https://macrolens-ai.yourname.workers.dev</code>). In <b>Profile → AI</b>, paste it as the <b>Proxy URL</b>, leave the API key empty, and tap <b>Test connection</b>.</p>
          <button class="btn primary block" data-goto="#/profile/ai">${icon('sliders', 16)} Open AI settings</button>
        </div></section>

        <p class="muted small">Privacy: when cloud AI is on, photos and chat messages (with the diary details Coach looks up) are sent to NVIDIA through your Worker. Switch Snap AI to <b>On-device</b> any time to keep photos on the phone.</p>
      </div>`,
  });

  let code = '';
  fetch(new URL('../../proxy/nvidia-proxy.js', import.meta.url))
    .then(r => (r.ok ? r.text() : Promise.reject(new Error(r.status))))
    .then(t => { code = t; sheet.el.querySelector('pre.code').textContent = t; })
    .catch(() => { sheet.el.querySelector('pre.code').textContent = 'Could not load proxy/nvidia-proxy.js — copy it from the GitHub repository instead.'; });

  sheet.el.addEventListener('click', e => {
    if (e.target.closest('[data-copy-code]')) { if (code) copy(code, 'Proxy code'); else toast('Still loading…'); }
    if (e.target.closest('[data-copy-origin]')) copy(origin, 'Site address');
    const go = e.target.closest('[data-goto]');
    if (go) closeAllSheets().then(() => { location.hash = go.dataset.goto; });
  });
  return sheet;
}
