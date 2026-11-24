// Coach agent harness: an observe→act loop over the diary/library tools.
//
// - Native OpenAI-style tool calling when the model supports it; otherwise a text protocol
//   (<tool_call>{json}</tool_call>) so any chat model can drive the tools.
// - Streaming replies, reasoning shown separately, up to MAX_STEPS tool rounds per message.
// - Approval gate for risky actions (policy in Profile → AI), undo for every change it makes.
// - Conversation persists in IndexedDB; photos are passed to vision-capable models directly and
//   to the grounded photo estimator through the analyze_photo tool.

import { chat, modelInfo, usesNativeTools, ToolsUnsupported, imagePart, CloudError, RETRYABLE, modelChain, AGENT_FALLBACKS } from '../cloud.js';
import { TOOLS, toolByName, toolSchemas, needsApproval } from './tools.js';
import * as db from '../db.js';
import * as store from '../store.js';
import { sum } from '../nutrition.js';
import { todayKey, mealForNow, mealName, uid } from '../util.js';

const MAX_STEPS = 12;
const CHAT_ID = 'current';
const MAX_ITEMS = 80; // conversation window sent to the model
const KEEP_FULL_IMAGES = 2; // older photos are kept as thumbnails only

const GOALS = { lose: 'lose fat', maintain: 'maintain weight', gain: 'build muscle' };

async function systemPrompt(native) {
  const s = store.getSettings();
  const tg = s.targets, p = s.profile;
  const today = todayKey();
  const entries = await store.getEntries(today);
  const t = sum(entries);
  const now = new Date();
  const lines = [
    "You are Coach, the AI assistant inside Macrolens, a calorie and macro tracking app. You can read and change the user's food diary, food library, targets, weight and water with the tools provided.",
    '',
    `Now: ${now.toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}. Today's date: ${today}. Current meal: ${mealName(mealForNow())}.`,
    `User: ${s.name || 'not named'} · ${p.sex}, ${p.age} y, ${p.heightCm} cm, ${p.weightKg} kg · goal: ${GOALS[p.goal] || p.goal}${p.goal !== 'maintain' ? ` (${p.rate} kg/week)` : ''} · diet style: ${p.diet} · units: ${s.units}.`,
    `Daily targets: ${tg.kcal} kcal · protein ${tg.protein} g · carbs ${tg.carbs} g · fat ${tg.fat} g · fiber ${tg.fiber} g · water ${tg.water} ml.`,
    `Logged today: ${Math.round(t.kcal)} kcal · P ${Math.round(t.protein)} · C ${Math.round(t.carbs)} · F ${Math.round(t.fat)} (${entries.length} entries, ${Math.round(tg.kcal - t.kcal)} kcal left).`,
    '',
    'How to work:',
    "- Use tools to look things up instead of guessing. Never invent diary contents, ids or nutrition values a tool can give you.",
    "- Logging food: search_foods with a short generic name (\"banana\", not \"medium banana\"), then pick the result that is the same food the user ate: start from best_match, prefer the user's own foods, then the plain generic food. Never swap in a processed variant (chips, dried, juice, powder) unless the user said so. Convert the amount to grams with the food's servings, then log_food. If nothing fits, quick_add a careful estimate and say it is an estimate.",
    '- Sanity-check before logging: the food name must match what the user said, and the calories must be realistic (a banana is about 105 kcal, not 600).',
    '- Meal photos: call analyze_photo, then log the returned items with log_food using their food_id and grams (adjust grams if the user corrects you).',
    '- To edit or delete entries, call get_diary first to get entry_ids.',
    '- Call independent tools together in one step when you can.',
    "- Dates are YYYY-MM-DD. Meals are breakfast, lunch, dinner and snacks; if the user doesn't say, use the current meal.",
    '- After changing anything, confirm briefly what changed and the new day totals versus targets.',
    "- Be concise, warm and practical. Prefer short bullet lists. Use the user's units.",
    '- You give general nutrition guidance, not medical advice. Never suggest intakes under 1200 kcal/day. Suggest a professional for medical conditions or disordered eating.',
  ];
  if (!native) lines.push('', textToolProtocol());
  return lines.join('\n');
}

function signature(t) {
  const props = t.parameters.properties || {};
  const req = new Set(t.parameters.required || []);
  const args = Object.entries(props).map(([k, v]) => `${k}${req.has(k) ? '' : '?'}: ${v.enum ? v.enum.map(e => `"${e}"`).join('|') : v.type}`);
  return `- ${t.name}(${args.join(', ')}): ${t.description}`;
}

function textToolProtocol() {
  return [
    '## Tools',
    'To use tools, reply with one or more blocks exactly like this and nothing else:',
    '<tool_call>{"name": "search_foods", "arguments": {"query": "banana"}}</tool_call>',
    'Results come back as <tool_result name="...">JSON</tool_result>. When you have what you need, answer normally with no tool_call blocks.',
    'Available tools:',
    ...TOOLS.map(signature),
  ].join('\n');
}

function parseTextCalls(content) {
  const calls = [];
  const text = content.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, (_, body) => {
    try {
      const j = JSON.parse(body.replace(/^```(?:json)?|```$/g, '').trim());
      if (j?.name) calls.push({ id: `t_${uid().slice(0, 8)}`, name: j.name, rawArgs: j.arguments ?? j.parameters ?? {} });
    } catch { calls.push({ id: `t_${uid().slice(0, 8)}`, name: '__invalid__', rawArgs: body }); }
    return '';
  }).trim();
  return { calls, text };
}

const prettyName = n => n.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());

export class Agent {
  constructor() {
    this.items = [];
    this.listeners = new Set();
    this.running = false;
    this.ctx = { foods: new Map(), images: [] };
    this.undos = new Map();
    this.pending = null;
    this.ready = this.load();
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(type, item) { this.listeners.forEach(fn => { try { fn(type, item); } catch (e) { console.error(e); } }); }

  async load() {
    try {
      const rec = await db.get('chats', CHAT_ID);
      this.items = (rec?.items || []).map(it => (it.role === 'tool' ? { ...it, undoable: false, status: it.status === 'approval' || it.status === 'running' ? 'error' : it.status } : it));
      for (const it of this.items) if (it.role === 'user') for (const img of it.images || []) this.ctx.images.push({ dataUrl: img.dataUrl || img.thumb, thumb: img.thumb });
    } catch (e) { console.warn('[coach] could not load chat', e); }
  }

  async save() {
    const withImages = this.items.filter(it => it.role === 'user' && it.images?.length);
    const keep = new Set(withImages.slice(-KEEP_FULL_IMAGES).map(it => it.id));
    const items = this.items.slice(-200).map(it => {
      if (it.role !== 'user' || !it.images?.length || keep.has(it.id)) return it;
      return { ...it, images: it.images.map(i => ({ thumb: i.thumb })) };
    });
    await db.put('chats', { id: CHAT_ID, items, updatedAt: Date.now() }).catch(e => console.warn('[coach] save failed', e));
  }

  async reset() {
    this.stop();
    this.items = [];
    this.ctx = { foods: new Map(), images: [] };
    this.undos.clear();
    await this.save();
    this.emit('reset');
  }

  stop() {
    this.ctrl?.abort();
    if (this.pending) { this.pending.resolve(false); this.pending = null; }
  }

  approve(itemId, ok) {
    if (this.pending?.item.id === itemId) { this.pending.resolve(ok); this.pending = null; }
  }

  async undo(itemId) {
    const fn = this.undos.get(itemId);
    const item = this.items.find(i => i.id === itemId);
    if (!fn || !item) return;
    await fn();
    this.undos.delete(itemId);
    item.undoable = false;
    item.undone = true;
    this.emit('update', item);
    await this.save();
  }

  async buildMessages(native, info, model) {
    const msgs = [{ role: 'system', content: await systemPrompt(native) }];
    // Start the window at a user turn so tool calls and their results stay paired.
    let start = Math.max(0, this.items.length - MAX_ITEMS);
    while (start > 0 && this.items[start].role !== 'user') start--;
    const window = this.items.slice(start).filter(it => it.role !== 'note');
    const imageUsers = window.filter(it => it.role === 'user' && it.images?.length).slice(-KEEP_FULL_IMAGES).map(it => it.id);

    let photoNo = this.items.slice(0, start).reduce((n, it) => n + (it.role === 'user' ? it.images?.length || 0 : 0), 0);
    for (const it of window) {
      if (it.role === 'user') {
        const imgs = it.images || [];
        const nums = imgs.map(() => ++photoNo);
        const label = imgs.length ? `\n[Attached photo${nums.length > 1 ? 's' : ''} #${nums.join(', #')}]` : '';
        const text = (it.text || (imgs.length ? 'Here is a photo.' : '')) + label;
        if (imgs.length && info.vision && imageUsers.includes(it.id) && imgs.every(i => i.dataUrl)) {
          msgs.push({ role: 'user', content: [{ type: 'text', text }, ...imgs.map(i => imagePart(i.dataUrl))] });
        } else {
          msgs.push({ role: 'user', content: text + (imgs.length ? ' Use analyze_photo to analyse it.' : '') });
        }
      } else if (it.role === 'assistant') {
        const args = c => (typeof c.args === 'string' ? c.args : JSON.stringify(c.args || {}));
        if (native) {
          const m = { role: 'assistant', content: it.text || '' };
          if (it.calls?.length) {
            m.tool_calls = it.calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: args(c) } }));
            if (it.rawReasoning && it.model === model) m.reasoning_content = it.rawReasoning; // Kimi expects its reasoning back with tool calls
          }
          msgs.push(m);
        } else {
          const blocks = (it.calls || []).map(c => `<tool_call>${JSON.stringify({ name: c.name, arguments: typeof c.args === 'string' ? safeJSON(c.args) : c.args || {} })}</tool_call>`);
          msgs.push({ role: 'assistant', content: [it.text, ...blocks].filter(Boolean).join('\n') || '…' });
        }
      } else if (it.role === 'tool') {
        const content = (it.result || '{}') + (it.undone ? '\n[The user undid this action afterwards.]' : '');
        if (native) msgs.push({ role: 'tool', tool_call_id: it.callId, content });
        else msgs.push({ role: 'user', content: `<tool_result name="${it.name}">${content}</tool_result>` });
      }
    }
    // Strict chat templates need alternating roles: merge adjacent plain-text user turns.
    return msgs.reduce((out, m) => {
      const prev = out[out.length - 1];
      if (prev && prev.role === 'user' && m.role === 'user' && typeof prev.content === 'string' && typeof m.content === 'string') prev.content += `\n${m.content}`;
      else out.push({ ...m });
      return out;
    }, []);
  }

  async runTool(call, policy) {
    const tool = toolByName.get(call.name);
    const item = { id: uid(), role: 'tool', callId: call.id, name: call.name, status: 'running', card: { icon: 'sparkles', title: prettyName(call.name || 'tool') } };
    const fail = msg => {
      Object.assign(item, { status: 'error', result: JSON.stringify({ error: msg }), card: { icon: 'info', title: `${prettyName(call.name || 'Tool')} failed`, detail: msg } });
      return item;
    };
    let args = call.rawArgs;
    try { if (typeof args === 'string') args = args.trim() ? JSON.parse(args) : {}; } catch { return fail('Arguments were not valid JSON.'); }
    if (!tool) return fail(`Unknown tool "${call.name}". Available: ${TOOLS.map(t => t.name).join(', ')}`);
    this.emit('item', item);

    if (needsApproval(tool, policy)) {
      let preview = prettyName(call.name);
      try { if (tool.preview) preview = await tool.preview(args, this.ctx); } catch (e) { return fail(e.message); }
      Object.assign(item, { status: 'approval', preview, risk: tool.risk });
      this.emit('update', item);
      const ok = await new Promise(resolve => { this.pending = { item, resolve }; });
      if (!ok) {
        Object.assign(item, { status: 'denied', result: JSON.stringify({ error: 'The user declined this action. Ask what they would like instead.' }), card: { icon: 'x', title: 'You declined', detail: preview } });
        return item;
      }
      item.status = 'running';
      this.emit('update', item);
    }

    try {
      const out = await tool.run(args, { ...this.ctx, signal: this.ctrl?.signal });
      Object.assign(item, { status: 'done', card: out.card, result: JSON.stringify(out.result).slice(0, 12000) });
      if (out.undo) { this.undos.set(item.id, out.undo); item.undoable = true; }
      return item;
    } catch (e) {
      return fail(e.message || String(e));
    }
  }

  async send(text, images = []) {
    if (this.running) return;
    await this.ready;
    const user = { id: uid(), role: 'user', text: String(text || '').trim(), images, at: Date.now() };
    if (!user.text && !images.length) return;
    this.items.push(user);
    images.forEach(i => this.ctx.images.push(i));
    this.emit('item', user);
    this.running = true;
    this.emit('state');
    this.ctrl = new AbortController();

    const ai = store.getSettings().ai;
    // Free-tier models can stall for minutes: fall back along a chain of models known to answer.
    const chain = modelChain(ai.agentModel, AGENT_FALLBACKS);
    let mi = 0;
    let model = chain[0];
    let info = modelInfo(model);
    let native = usesNativeTools(model);
    if (model !== ai.agentModel) this.note(`${modelInfo(ai.agentModel).label} was busy recently, so Coach is using ${info.label}.`);
    let lastSig = '', repeats = 0;

    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        const live = { id: uid(), role: 'assistant', text: '', thought: '', calls: [], streaming: true, model };
        this.emit('item', live);
        let r;
        try {
          r = await chat({
            model,
            messages: await this.buildMessages(native, info, model),
            tools: native ? toolSchemas() : undefined,
            signal: this.ctrl.signal,
            onDelta: d => { live.text = d.content; live.thought = d.thought; this.emit('delta', live); },
          });
        } catch (e) {
          this.emit('remove', live);
          if (e instanceof ToolsUnsupported && native) { native = false; step--; continue; }
          if (e instanceof CloudError && RETRYABLE.has(e.status) && mi + 1 < chain.length) {
            const prev = info.label;
            model = chain[++mi];
            info = modelInfo(model);
            native = usesNativeTools(model);
            this.note(`${prev} didn't respond, so Coach switched to ${info.label}.`);
            step--;
            continue;
          }
          throw e;
        }

        let calls;
        if (native) calls = (r.toolCalls || []).filter(tc => tc.function?.name).map(tc => ({ id: tc.id || `c_${uid().slice(0, 8)}`, name: tc.function.name, rawArgs: tc.function.arguments }));
        else { const p = parseTextCalls(r.content); calls = p.calls; r.content = p.text; }

        Object.assign(live, { text: r.content, thought: r.thought, rawReasoning: r.rawReasoning, calls: calls.map(c => ({ id: c.id, name: c.name, args: c.rawArgs })), streaming: false });
        this.items.push(live);
        this.emit('update', live);
        if (!calls.length) {
          if (!live.text && r.finish === 'length') this.note('The model ran out of output tokens. Try "Fast" reasoning in Profile → AI.');
          break;
        }

        const sig = JSON.stringify(calls.map(c => [c.name, c.rawArgs]));
        repeats = sig === lastSig ? repeats + 1 : 0;
        lastSig = sig;
        if (repeats >= 2) { this.note('Coach was repeating the same action, so it was stopped.'); break; }

        for (const c of calls) {
          if (this.ctrl.signal.aborted) throw new DOMException('Aborted', 'AbortError');
          const res = await this.runTool(c, ai.approval);
          if (!this.items.includes(res)) this.items.push(res);
          this.emit('update', res);
        }
        await this.save();
        if (step === MAX_STEPS - 1) this.note(`Stopped after ${MAX_STEPS} steps. Say "continue" to carry on.`);
      }
    } catch (e) {
      if (e.name === 'AbortError') this.note('Stopped.');
      else this.note(e.message || String(e), true);
    } finally {
      this.running = false;
      this.ctrl = null;
      await this.save();
      this.emit('state');
    }
  }

  note(text, error = false) {
    const n = { id: uid(), role: 'note', text, error };
    this.items.push(n);
    this.emit('item', n);
  }

  // Re-send the last user message (after an error).
  async retry() {
    const lastUser = [...this.items].reverse().find(i => i.role === 'user');
    if (!lastUser || this.running) return;
    const idx = this.items.lastIndexOf(lastUser);
    this.items = this.items.slice(0, idx);
    this.emit('reset');
    await this.send(lastUser.text, lastUser.images || []);
  }
}

function safeJSON(s) { try { return JSON.parse(s); } catch { return {}; } }

export const agent = new Agent();
