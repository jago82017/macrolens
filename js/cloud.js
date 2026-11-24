// NVIDIA API catalog client (OpenAI-compatible chat completions) with streaming, tool calls,
// per-model reasoning controls and automatic fallbacks for models that reject optional parameters.
//
// Browsers can't call integrate.api.nvidia.com directly (it sends no CORS headers), so requests go
// through a tiny proxy the user deploys (see proxy/nvidia-proxy.js). The proxy can hold the API key.

import { getSettings } from './store.js';

// Known catalog models. Capabilities come from NVIDIA's model docs (Nov 2026); unknown ids still work
// as "custom" models with no extra parameters.
export const MODELS = [
  { id: 'moonshotai/kimi-k3.1-pro', label: 'Kimi K3.1 Pro', vendor: 'Moonshot', vision: true, tools: true, reasoning: 'effort', temperature: 1.0, top_p: 0.95, note: 'Most capable · vision + tools · 1M context' },
  { id: 'nvidia/nemotron-3.5-super-vl-120b-a12b', label: 'Nemotron 3.5 Super VL', vendor: 'NVIDIA', vision: true, tools: true, reasoning: 'thinking', temperature: 0.6, top_p: 0.95, note: "NVIDIA's flagship vision-language model" },
  { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', label: 'Nemotron 3 Nano Omni', vendor: 'NVIDIA', vision: true, tools: true, reasoning: 'thinking', temperature: 0.6, top_p: 0.95, note: 'Fast · vision + tools' },
  { id: 'z-ai/glm-5.3-flash', label: 'GLM-5.3 Flash', vendor: 'Z.ai', vision: true, tools: true, reasoning: 'effort', temperature: 0.7, top_p: 0.95, note: 'Fast · vision + tools' },
  { id: 'mistralai/mistral-large-4-1t-a52b', label: 'Mistral Large 4', vendor: 'Mistral', vision: true, tools: true, reasoning: 'effort3', temperature: 1.0, top_p: 0.95, note: 'Vision + tools' },
  { id: 'google/gemma-4-31b-it', label: 'Gemma 4 31B', vendor: 'Google', vision: true, tools: false, reasoning: 'gemma', temperature: 1.0, top_p: 0.95, note: 'Vision · tools via text protocol' },
  { id: 'nvidia/nemotron-3-ultra-550b-a55b', label: 'Nemotron 3 Ultra', vendor: 'NVIDIA', vision: false, tools: true, reasoning: 'thinking', temperature: 1.0, top_p: 0.95, note: 'Largest · text only (photos go to the vision model)' },
];

export const modelInfo = id => MODELS.find(m => m.id === id) || { id, label: id.split('/').pop(), vendor: id.split('/')[0], vision: true, tools: true, reasoning: null, custom: true };
export const visionModels = () => MODELS.filter(m => m.vision);

// ---------- Connection ----------
export function connection() {
  const ai = getSettings().ai || {};
  let base = String(ai.endpoint || '').trim().replace(/\/+$/, '');
  if (base && !/\/v1$/.test(base)) base += '/v1';
  return { base, key: String(ai.apiKey || '').trim() };
}
export const isConfigured = () => !!connection().base;

export class CloudError extends Error {
  constructor(message, status = 0, detail = '') {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}
export class ToolsUnsupported extends Error {}

function friendly(status, text, model) {
  if (status === 401) return 'NVIDIA rejected the API key. Check the key in Profile → AI (or the NVIDIA_API_KEY secret in your proxy).';
  if (status === 403) return /origin/i.test(text) ? 'Your proxy blocked this site. Add it to ALLOWED_ORIGINS in the proxy settings.' : 'Access denied by NVIDIA for this model.';
  if (status === 404) return `Model "${model}" isn't available on NVIDIA right now. Pick another model in Profile → AI.`;
  if (status === 429) return 'NVIDIA free-tier rate limit reached. Wait a minute and try again.';
  if (status === 413) return 'The request was too large (photo too big).';
  if (status >= 500) return `NVIDIA's servers had a problem (${status}). Try again, or switch model.`;
  return `Request failed (${status}). ${text.slice(0, 200)}`;
}

// Per-model quirks learned at runtime (e.g. "rejects reasoning_effort"), remembered for this device.
const QUIRK_KEY = 'ml-ai-quirks';
let quirks = {};
try { quirks = JSON.parse(localStorage.getItem(QUIRK_KEY) || '{}'); } catch { /* storage unavailable */ }
function setQuirk(model, patch) {
  quirks[model] = { ...quirks[model], ...patch };
  try { localStorage.setItem(QUIRK_KEY, JSON.stringify(quirks)); } catch { /* ignore */ }
}
export const usesNativeTools = model => modelInfo(model).tools !== false && !quirks[model]?.noTools;
export function resetQuirks() { quirks = {}; try { localStorage.removeItem(QUIRK_KEY); } catch { /* ignore */ } }

function reasoningParams(m, effort) {
  const e = effort || getSettings().ai?.effort || 'balanced';
  switch (m.reasoning) {
    case 'effort': return { reasoning_effort: { fast: 'low', balanced: 'high', deep: 'max' }[e] };
    case 'effort3': return { reasoning_effort: { fast: 'low', balanced: 'medium', deep: 'high' }[e] };
    case 'thinking': return { chat_template_kwargs: { enable_thinking: e !== 'fast' } };
    default: return {};
  }
}

// ---------- Response clean-up ----------
// Some models put their reasoning inline (<think>…</think>, Gemma channel tags). Split it out.
export function splitThinking(raw = '', reasoning = '') {
  let content = String(raw);
  let thought = String(reasoning || '');
  content = content.replace(/<think>([\s\S]*?)<\/think>/gi, (_, t) => { thought += t; return ''; });
  const close = content.indexOf('</think>');
  if (close >= 0) { thought += content.slice(0, close); content = content.slice(close + 8); }
  content = content.replace(/<\|channel>thought([\s\S]*?)<channel\|>/g, (_, t) => { thought += t; return ''; });
  // Still streaming inside an unterminated think block: hide it from the visible text.
  const open = content.search(/<think>|<\|channel>thought/);
  if (open >= 0) { thought += content.slice(open).replace(/<think>|<\|channel>thought/, ''); content = content.slice(0, open); }
  return { content: content.trim(), thought: thought.trim() };
}

// Pull the first JSON object out of a model reply (handles code fences, prose and trailing commas).
export function extractJSON(text) {
  const { content } = splitThinking(text);
  const src = content.replace(/```(?:json)?/gi, '');
  const start = src.indexOf('{');
  if (start < 0) throw new Error('No JSON in reply');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      const chunk = src.slice(start, i + 1);
      try { return JSON.parse(chunk); } catch { return JSON.parse(chunk.replace(/,\s*([}\]])/g, '$1')); }
    }
  }
  throw new Error('Unterminated JSON in reply');
}

async function* sse(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try { yield JSON.parse(data); } catch { /* partial keep-alive lines */ }
    }
  }
}

/**
 * One chat completion. Returns { content, thought, toolCalls, finish, usage }.
 * onDelta({ content, thought, toolCalls }) fires while streaming.
 */
export async function chat({ model, messages, tools, stream = true, signal, onDelta, maxTokens = 4096, effort, temperature }) {
  const { base, key } = connection();
  if (!base) throw new CloudError('Cloud AI is not set up yet. Add your proxy URL in Profile → AI.');
  const m = modelInfo(model);
  const q = quirks[model] || {};

  let msgs = messages;
  if (m.reasoning === 'gemma' && (effort || getSettings().ai?.effort) !== 'fast' && msgs[0]?.role === 'system') {
    msgs = [{ ...msgs[0], content: `<|think|>${msgs[0].content}` }, ...msgs.slice(1)];
  }
  const body = {
    model,
    messages: msgs,
    max_tokens: maxTokens,
    temperature: temperature ?? m.temperature ?? 0.6,
    top_p: m.top_p ?? 0.95,
    stream: stream && !q.noStream,
  };
  if (tools?.length) {
    if (q.noTools || m.tools === false) throw new ToolsUnsupported();
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  if (!q.noExtras) Object.assign(body, reasoningParams(m, effort));

  let res;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: body.stream ? 'text/event-stream' : 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new CloudError(navigator.onLine ? "Can't reach your AI proxy. Check the URL in Profile → AI." : "You're offline.");
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 400 || res.status === 422) {
      const retry = patch => { setQuirk(model, patch); return chat({ model, messages, tools, stream, signal, onDelta, maxTokens, effort, temperature }); };
      if (body.tools && /tool/i.test(text)) { setQuirk(model, { noTools: true }); throw new ToolsUnsupported(); }
      if (!q.noExtras && /reasoning|chat_template|thinking|unexpected|extra|unrecognized|not permitted|unknown/i.test(text)) return retry({ noExtras: true });
      if (body.stream && /stream/i.test(text)) return retry({ noStream: true });
    }
    throw new CloudError(friendly(res.status, text, model), res.status, text);
  }

  if (!body.stream) {
    const j = await res.json();
    const ch = j.choices?.[0] || {};
    const msg = ch.message || {};
    const { content, thought } = splitThinking(msg.content || '', msg.reasoning_content || msg.reasoning);
    return { content, thought, rawReasoning: msg.reasoning_content || '', toolCalls: msg.tool_calls || [], finish: ch.finish_reason, usage: j.usage };
  }

  let raw = '', reasoning = '', finish, usage;
  const calls = [];
  for await (const chunk of sse(res)) {
    if (chunk.usage) usage = chunk.usage;
    const ch = chunk.choices?.[0];
    if (!ch) continue;
    const d = ch.delta || {};
    const r = d.reasoning_content ?? d.reasoning;
    if (r) reasoning += r;
    if (d.content) raw += d.content;
    for (const tc of d.tool_calls || []) {
      const i = tc.index ?? calls.length;
      calls[i] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (tc.id) calls[i].id = tc.id;
      if (tc.function?.name) calls[i].function.name += tc.function.name;
      if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments;
    }
    if (ch.finish_reason) finish = ch.finish_reason;
    if (onDelta && (r || d.content || d.tool_calls)) onDelta({ ...splitThinking(raw, reasoning), toolCalls: calls });
  }
  const { content, thought } = splitThinking(raw, reasoning);
  return { content, thought, rawReasoning: reasoning, toolCalls: calls.filter(Boolean), finish, usage };
}

// ---------- Utilities for settings ----------
export async function listModels() {
  const { base, key } = connection();
  const r = await fetch(`${base}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {} });
  if (!r.ok) throw new CloudError(friendly(r.status, await r.text().catch(() => ''), ''), r.status);
  return ((await r.json()).data || []).map(x => x.id).sort();
}

export async function testConnection() {
  const t0 = performance.now();
  const ids = await listModels();
  const ai = getSettings().ai;
  const missing = [ai.agentModel, ai.visionModel].filter(id => !ids.includes(id));
  const r = await chat({ model: ai.agentModel, messages: [{ role: 'user', content: 'Reply with the single word: ready' }], stream: false, maxTokens: 400, effort: 'fast' });
  return { ok: true, ms: Math.round(performance.now() - t0), models: ids.length, missing, reply: r.content.slice(0, 40) };
}

// Downscale a photo for upload: long side ≤ max px, JPEG. Returns { dataUrl, thumb, blob }.
export async function compressImage(file, max = 1024, quality = 0.82) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * s);
  canvas.height = Math.round(bmp.height * s);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  const side = Math.min(bmp.width, bmp.height);
  const t = document.createElement('canvas');
  t.width = t.height = 160;
  t.getContext('2d').drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, 160, 160);
  bmp.close?.();
  return { dataUrl, thumb: t.toDataURL('image/jpeg', 0.75) };
}

export const imagePart = url => ({ type: 'image_url', image_url: { url } });
