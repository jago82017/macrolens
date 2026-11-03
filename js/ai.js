// On-device meal photo estimator.
//
// The model (MobileCLIP-S0 in a Web Worker) never invents numbers. It only answers multiple-choice
// questions about the photo; nutrition is injected from the reference database.
//
//   1. Identify   – zero-shot over the food vocabulary (built-ins + the user's custom foods), with
//                   prompt ensembles (4 templates per food) and test-time augmentation (4 crops/flips).
//   2. Inject     – optional user hint ("chicken curry ~300 g") steers the label and overrides weight.
//   3. Remember   – few-shot kNN over photos the user previously confirmed (learns their regular meals,
//                   including scanned products the vocabulary doesn't know).
//   4. Portion    – a second run comparing portion-size prompts for the chosen food → serving multiplier.
//   5. Prep       – a third run for cooking method on base ingredients (grilled vs fried vs sauced).
//   6. Density    – a fourth run for mixed dishes (light vs rich) → bounded calorie adjustment.
//   7. Confidence – top-1 probability, margin, and agreement across augmented views.
//
// Text embeddings for every built-in prompt ship precomputed (models/*.bin), so a photo only needs
// the 43 MB vision tower. The text tower downloads lazily for hints and custom foods.

import * as db from './db.js';
import { BUILTIN_FOODS } from './fooddb.js';
import { allFoods } from './store.js';
import { scale } from './nutrition.js';
import { uid, clamp } from './util.js';

export const MODEL_ID = 'Xenova/mobileclip_s0';
export const MODEL_SIZE_MB = { vision: 44, text: 43 };
export const EMB_NS = 'mcs0:v1|';
const MODEL_FILES = { vision: ['onnx/vision_model.onnx'], text: ['onnx/text_model_quantized.onnx'] };
const BUNDLE_URL = new URL('../models/mcs0-text-v1', import.meta.url).href;
const MEMORY_CAP = 400;

export const TEMPLATES = [
  'a photo of {}, a type of food.',
  'a close-up photo of {}.',
  'a photo of a plate of {}.',
  'a top-down photo of {} on a table.',
];

const PORTION_SHRINK = 0.6;
export const PORTIONS = [
  { t: 'a tiny bite-sized amount of {}', m: 0.4 },
  { t: 'a small portion of {}', m: 0.7 },
  { t: 'a regular single serving of {}', m: 1.0 },
  { t: 'a large portion of {}', m: 1.45 },
  { t: 'a huge oversized portion of {}', m: 2.0 },
];

// Per-100 g deltas added on top of the plain-cooked reference values.
export const PREPS = [
  { id: 'plain', label: 'Steamed / boiled', t: 'plain steamed or boiled {}', d: {} },
  { id: 'grilled', label: 'Grilled / roasted', t: 'grilled or roasted {}', d: { fat: 2 } },
  { id: 'pan', label: 'Pan-fried in oil', t: '{} pan-fried in oil', d: { fat: 5 } },
  { id: 'fried', label: 'Deep-fried / breaded', t: 'deep-fried breaded {}', d: { fat: 10, carbs: 10, protein: -1 } },
  { id: 'sauce', label: 'In creamy sauce', t: '{} in a creamy cheese sauce', d: { fat: 6, carbs: 3, protein: 1 } },
];

export const DENSITY = [
  { t: 'a light, healthy, low-calorie {}', f: 0.88 },
  { t: 'a typical homemade {}', f: 1.0 },
  { t: 'a rich, greasy, high-calorie {}', f: 1.15 },
];
const DENSITY_CATS = new Set(['dish', 'asian', 'salad', 'soup', 'breakfast', 'dessert']);

const labelOf = food => food.label || food.name.toLowerCase();

// Every prompt the pipeline may ask about a food (also used to build the precomputed bundle).
export function promptSets(food) {
  const label = labelOf(food);
  const fill = t => t.replace('{}', label);
  return {
    vocab: TEMPLATES.map(fill),
    portion: PORTIONS.map(p => fill(p.t)),
    prep: food.adj ? PREPS.map(p => fill(p.t)) : [],
    density: DENSITY_CATS.has(food.category) ? DENSITY.map(d => fill(d.t)) : [],
  };
}

// ---------- Vector math ----------
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
function normalize(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const o = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) o[i] = v[i] / n;
  return o;
}
function mean(vs) {
  const o = new Float32Array(vs[0].length);
  for (const v of vs) for (let i = 0; i < v.length; i++) o[i] += v[i];
  return normalize(o);
}
function softmax(xs) {
  const m = Math.max(...xs);
  const e = xs.map(x => Math.exp(x - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map(x => x / s);
}
const argmax = xs => xs.reduce((bi, x, i, a) => (x > a[bi] ? i : bi), 0);
const renorm = xs => { const s = xs.reduce((a, b) => a + b, 0) || 1; return xs.map(x => x / s); };

// ---------- Worker RPC ----------
let worker, seq = 0;
const pending = new Map();
const progressSubs = new Set();
export const aiState = { status: 'idle', progress: 0, error: null, text: false };

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./ai-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = e => {
    const { id, type, data, error } = e.data;
    if (type === 'progress') {
      aiState.progress = data.progress;
      progressSubs.forEach(fn => fn(data));
      return;
    }
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    error ? p.reject(new Error(error)) : p.resolve(data);
  };
  worker.onerror = e => {
    const err = new Error(e.message || 'AI worker failed to start (are you offline on first use?)');
    pending.forEach(p => p.reject(err));
    pending.clear();
    worker.terminate();
    worker = null;
    loads.clear();
    aiState.status = 'error';
    aiState.error = err.message;
  };
  return worker;
}

function call(type, payload = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, type, payload: { ...payload, model: MODEL_ID } });
  });
}

const loads = new Map();
function loadPart(part) {
  if (!loads.has(part)) {
    loads.set(part, call('load', { parts: [part] }).then(
      r => { if (part === 'text') aiState.text = true; return r; },
      err => { loads.delete(part); throw err; },
    ));
  }
  return loads.get(part);
}

/** Load model towers ('vision' for photos; add 'text' for hints/custom foods/offline prep). */
export async function loadModel(onProgress, parts = ['vision']) {
  if (onProgress) progressSubs.add(onProgress);
  aiState.status = 'loading';
  aiState.error = null;
  try {
    await Promise.all(parts.map(loadPart));
    aiState.status = 'ready';
    aiState.progress = 1;
  } catch (err) {
    aiState.status = 'error';
    aiState.error = err.message;
    throw err;
  } finally {
    if (onProgress) progressSubs.delete(onProgress);
  }
}

export async function isModelCached(part = 'all') {
  try {
    const cache = await caches.open('transformers-cache');
    const list = part === 'all' ? [...MODEL_FILES.vision, ...MODEL_FILES.text] : MODEL_FILES[part];
    const hits = await Promise.all(list.map(f => cache.match(`https://huggingface.co/${MODEL_ID}/resolve/main/${f}`)));
    return hits.every(Boolean);
  } catch { return false; }
}

async function textAvailable() {
  if (aiState.text) return true;
  return isModelCached('text');
}

// ---------- Text embeddings: shipped bundle → IndexedDB cache → text tower ----------
let embMapPromise;
function embCache() {
  embMapPromise ??= (async () => {
    const map = new Map((await db.all('embeddings')).map(r => [r.key, r.v]));
    try {
      const [meta, buf] = await Promise.all([
        fetch(`${BUNDLE_URL}.json`).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }),
        fetch(`${BUNDLE_URL}.bin`).then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); }),
      ]);
      if (meta.ns === EMB_NS) {
        const d = meta.dims, stride = 4 + d, view = new DataView(buf);
        meta.keys.forEach((k, i) => {
          if (map.has(EMB_NS + k)) return;
          const off = i * stride;
          const s = view.getFloat32(off, true);
          const q = new Int8Array(buf, off + 4, d);
          const v = new Float32Array(d);
          for (let j = 0; j < d; j++) v[j] = q[j] * s;
          map.set(EMB_NS + k, normalize(v));
        });
      }
    } catch (e) { console.warn('[ai] precomputed text embeddings unavailable:', e.message); }
    return map;
  })();
  return embMapPromise;
}

async function cachedEmbeds(texts) {
  const cache = await embCache();
  return texts.map(t => cache.get(EMB_NS + t) || null);
}

async function embedTexts(texts, onProgress) {
  const cache = await embCache();
  const out = texts.map(t => cache.get(EMB_NS + t) || null);
  const missing = out.map((v, i) => (v ? -1 : i)).filter(i => i >= 0);
  const B = 24;
  for (let b = 0; b < missing.length; b += B) {
    const idx = missing.slice(b, b + B);
    const res = await call('embedText', { texts: idx.map(i => texts[i]) });
    aiState.text = true;
    const d = res.dims[1];
    const recs = idx.map((i, j) => {
      const v = res.data.slice(j * d, (j + 1) * d);
      out[i] = v;
      cache.set(EMB_NS + texts[i], v);
      return { key: EMB_NS + texts[i], v };
    });
    await db.bulkPut('embeddings', recs);
    onProgress?.(Math.min(1, (b + idx.length) / missing.length));
  }
  return out;
}

// Embeds if possible without forcing a download; returns null when the text tower isn't available yet.
async function softEmbed(texts) {
  const got = await cachedEmbeds(texts);
  if (got.every(Boolean)) return got;
  if (!(await textAvailable())) { loadPart('text').catch(() => {}); return null; } // warm it for next time
  return embedTexts(texts);
}

async function vocabulary() {
  const foods = [...BUILTIN_FOODS];
  if (await textAvailable()) {
    const custom = (await allFoods()).filter(f => f.source === 'custom' && f.name).slice(0, 150);
    foods.push(...custom.map(f => ({ ...f, label: f.name.toLowerCase() })));
  }
  return foods;
}

async function labelEmbeddings(foods, onProgress) {
  const k = TEMPLATES.length;
  const embs = await embedTexts(foods.flatMap(f => promptSets(f).vocab), onProgress);
  return foods.map((_, i) => mean(embs.slice(i * k, (i + 1) * k)));
}

// Download both towers and pre-compute custom-food prompts so everything works offline.
export async function prepareAI(onProgress) {
  await loadModel(p => onProgress?.('model', p.progress), ['vision', 'text']);
  const foods = await vocabulary();
  await labelEmbeddings(foods, p => onProgress?.('vocab', p));
}

// ---------- Image preparation (test-time augmentation views) ----------
async function prepareImage(file) {
  const bmp = await createImageBitmap(file);
  const W = bmp.width, H = bmp.height, S = Math.min(W, H);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const render = (sx, sy, sw, sh, out, { flip = false, letterbox = false, dataUrl = false, q = 0.9 } = {}) => {
    canvas.width = out;
    canvas.height = out;
    ctx.save();
    ctx.fillStyle = '#7f7f7f';
    ctx.fillRect(0, 0, out, out);
    if (flip) { ctx.translate(out, 0); ctx.scale(-1, 1); }
    if (letterbox) {
      const s = out / Math.max(sw, sh);
      ctx.drawImage(bmp, sx, sy, sw, sh, (out - sw * s) / 2, (out - sh * s) / 2, sw * s, sh * s);
    } else {
      ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, out, out);
    }
    ctx.restore();
    if (dataUrl) return Promise.resolve(canvas.toDataURL('image/jpeg', q));
    return new Promise(r => canvas.toBlob(r, 'image/jpeg', q));
  };
  const cx = (W - S) / 2, cy = (H - S) / 2, z = S * 0.72;
  const views = [
    await render(cx, cy, S, S, 288),                    // centre square
    await render(cx, cy, S, S, 288, { flip: true }),    // mirrored
    await render((W - z) / 2, (H - z) / 2, z, z, 288),  // zoomed onto the plate
    await render(0, 0, W, H, 288, { letterbox: true }), // whole frame, nothing cropped
  ];
  const thumb = await render(cx, cy, S, S, 160, { dataUrl: true, q: 0.78 });
  bmp.close?.();
  return { views, thumb };
}

function parseHint(hint) {
  let text = String(hint || '').trim();
  let grams;
  const m = text.match(/(\d+(?:[.,]\d+)?)\s*(kg|g|grams?|gr|ml|oz)\b/i);
  if (m) {
    let v = parseFloat(m[1].replace(',', '.'));
    const u = m[2].toLowerCase();
    if (u === 'kg') v *= 1000;
    if (u === 'oz') v *= 28.35;
    grams = v;
    text = text.replace(m[0], ' ');
  }
  text = text.replace(/[~≈]|\b(about|approx\.?|around|roughly|of)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  return { text: text.length >= 3 ? text : '', grams };
}

const roundTo = (n, s = 5) => Math.max(s, Math.round(n / s) * s);

function snapshot(f) {
  return {
    id: f.id, name: f.name, label: labelOf(f), emoji: f.emoji, brand: f.brand, image: f.image,
    source: f.source, category: f.category, adj: !!f.adj, per100: f.per100, servings: f.servings || [],
  };
}

const expectProbs = (img, embs, scale = 40) => softmax(embs.map(e => scale * dot(img, e)));

// ---------- Analysis result ----------
class MealAnalysis {
  constructor(o) {
    Object.assign(this, o);
    this.cache = new Map();
  }

  memoryGrams(foodId) {
    const hits = (this.memorySims || []).filter(x => x.m.food.id === foodId && x.s > 0.75);
    if (!hits.length) return null;
    let w = 0, g = 0;
    for (const { m, s } of hits) { const k = Math.exp((s - 1) * 20); w += k; g += k * m.grams; }
    return g / w;
  }

  // Runs the portion / preparation / density passes for one food.
  async estimate(food, { primary = false } = {}) {
    if (this.cache.has(food.id)) return this.cache.get(food.id);
    const sets = promptSets(food);
    const serving = food.servings?.[0]?.grams || 100;

    let mult = 1;
    let gramsSource = 'serving';
    const pe = await softEmbed(sets.portion);
    if (pe) {
      const raw = expectProbs(this.img, pe).reduce((s, p, i) => s + p * PORTIONS[i].m, 0);
      // CLIP's portion signal is weak and close-ups skew "large", so shrink toward a typical serving.
      mult = 1 + (raw - 1) * PORTION_SHRINK;
      gramsSource = 'portion';
    }
    let grams = serving * mult;
    const memG = this.memoryGrams(food.id);
    if (memG) { grams = 0.35 * grams + 0.65 * memG; gramsSource = 'memory'; }
    if (primary && this.hintGrams) { grams = this.hintGrams; gramsSource = 'hint'; }

    let prep = null;
    if (sets.prep.length) {
      const e = await softEmbed(sets.prep);
      if (e) {
        const probs = expectProbs(this.img, e);
        const k = argmax(probs);
        prep = { id: PREPS[k].id, label: PREPS[k].label, p: probs[k], probs };
      }
    }

    let density = 1;
    if (sets.density.length) {
      const e = await softEmbed(sets.density);
      if (e) density = expectProbs(this.img, e).reduce((s, p, i) => s + p * DENSITY[i].f, 0);
    }

    const est = { grams: roundTo(grams), mult, gramsSource, prep, density };
    this.cache.set(food.id, est);
    return est;
  }

  // Store confirmed items so future photos of the same meal are recognised (few-shot memory).
  async remember(items) {
    if (!items.length) return;
    const recs = items.map(({ food, grams }) => ({ id: uid(), emb: this.img, food: snapshot(food), grams, ts: Date.now() }));
    await db.bulkPut('aiMemory', recs);
    const all = await db.all('aiMemory');
    if (all.length > MEMORY_CAP) {
      const old = all.sort((a, b) => a.ts - b.ts).slice(0, all.length - MEMORY_CAP).map(r => r.id);
      await db.bulkDel('aiMemory', old);
    }
  }
}

/** Nutrients for an AI item: injected reference values × grams, plus prep deltas and density factor. */
export function computeNutrients(food, grams, est, prepChoice = 'auto') {
  const n = scale(food.per100, grams);
  n.protein ||= 0; n.carbs ||= 0; n.fat ||= 0; n.kcal ||= 0;
  const f = grams / 100;
  let dP = 0, dC = 0, dF = 0;
  if (est?.prep) {
    const apply = (pr, w) => { dP += w * (pr.d.protein || 0); dC += w * (pr.d.carbs || 0); dF += w * (pr.d.fat || 0); };
    if (prepChoice === 'auto') est.prep.probs.forEach((p, i) => apply(PREPS[i], p));
    else { const pr = PREPS.find(x => x.id === prepChoice); if (pr) apply(pr, 1); }
  }
  n.protein += dP * f;
  n.carbs += dC * f;
  n.fat += dF * f;
  n.kcal += (dP * 4 + dC * 4 + dF * 9) * f;
  if (est?.density && Math.abs(est.density - 1) > 0.005) {
    const fat0 = n.fat, carb0 = n.carbs;
    n.fat *= est.density;
    n.carbs *= 1 + (est.density - 1) * 0.5;
    n.kcal += (n.fat - fat0) * 9 + (n.carbs - carb0) * 4;
  }
  return n;
}

export async function analyzeMeal(file, { hint = '', onStep = () => {} } = {}) {
  onStep('prepare');
  const { views, thumb } = await prepareImage(file);
  const parsed = parseHint(hint);

  onStep('model', 0);
  await loadModel(p => onStep('model', p.progress), parsed.text ? ['vision', 'text'] : ['vision']);

  onStep('vocab', 0);
  const foods = await vocabulary();
  const labelEmbs = await labelEmbeddings(foods, p => onStep('vocab', p));

  onStep('vision');
  const res = await call('embedImages', { blobs: views });
  const d = res.dims[1];
  const viewEmbs = Array.from({ length: res.dims[0] }, (_, i) => res.data.slice(i * d, (i + 1) * d));
  const img = mean(viewEmbs);

  onStep('identify');
  let probs = softmax(labelEmbs.map(e => 100 * dot(img, e)));
  const viewTop = viewEmbs.map(v => argmax(labelEmbs.map(e => dot(v, e))));

  // Hint injection: semantic match (text↔text) plus a lexical boost, combined log-linearly.
  if (parsed.text) {
    const [h] = await embedTexts([`a photo of ${parsed.text}, a type of food.`]);
    const hp = softmax(labelEmbs.map(e => 60 * dot(h, e)));
    const words = parsed.text.toLowerCase().split(/[^a-z]+/).filter(w => w.length > 2);
    probs = renorm(probs.map((p, i) => p * Math.pow(hp[i], 0.8) * (words.some(w => foods[i].label.includes(w)) ? 4 : 1)));
  }

  // Few-shot memory from previously confirmed photos.
  const memory = await db.all('aiMemory');
  let memorySims = [], memoryMatch = null;
  if (memory.length) {
    memorySims = memory.map(m => ({ m, s: dot(img, m.emb) }));
    const best = Math.max(...memorySims.map(x => x.s));
    if (best > 0.8) {
      const alpha = clamp((best - 0.8) / 0.12, 0, 0.75);
      const votes = new Map();
      for (const { m, s } of memorySims) {
        if (s > best - 0.08) votes.set(m.food.id, (votes.get(m.food.id) || 0) + Math.exp((s - best) * 40));
      }
      const total = [...votes.values()].reduce((a, b) => a + b, 0);
      const index = new Map(foods.map((f, i) => [f.id, i]));
      probs = probs.map(p => p * (1 - alpha));
      for (const [fid, v] of votes) {
        const w = (alpha * v) / total;
        if (index.has(fid)) probs[index.get(fid)] += w;
        else {
          foods.push(memorySims.find(x => x.m.food.id === fid).m.food);
          probs.push(w);
        }
      }
      memoryMatch = { similarity: best, weight: alpha };
    }
  }

  const ranked = probs.map((p, i) => ({ i, p })).sort((a, b) => b.p - a.p);
  const candidates = ranked.slice(0, 6).filter((r, k) => k < 3 || r.p > 0.03).map(r => ({ food: foods[r.i], p: r.p }));

  const p1 = ranked[0].p, p2 = ranked[1]?.p || 0;
  const agreement = viewTop.filter(t => t === ranked[0].i).length / viewTop.length;
  const score = 0.5 * p1 + 0.3 * agreement + 0.2 * Math.min(1, (p1 - p2) * 2);
  const confidence = score >= 0.6 ? 'high' : score >= 0.35 ? 'medium' : 'low';

  const analysis = new MealAnalysis({
    img, thumb, candidates, confidence, score, agreement, memoryMatch, memorySims,
    hint: parsed.text, hintGrams: parsed.grams,
  });

  onStep('portion');
  await analysis.estimate(candidates[0].food, { primary: true });
  onStep('done');
  return analysis;
}

export const memoryCount = () => db.count('aiMemory');
export const clearMemory = () => db.clear('aiMemory');
