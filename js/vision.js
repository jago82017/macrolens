// Cloud meal-photo estimator (NVIDIA vision models).
//
// The large vision model does what it is good at: seeing every item, counting pieces and judging
// volume against scale references (plate, cutlery, hands). Its numbers are then *grounded*:
//   1. Library-aware prompt   – the user's own foods and past corrections are injected into the prompt.
//   2. Structured estimate    – strict JSON per item: grams with a low/high range, count, cooking method,
//                               confidence, and the model's own macro estimate.
//   3. Optional second pass   – "High accuracy" runs an independent re-count and merges both passes;
//                               disagreement lowers confidence.
//   4. Nutrition injection    – each item is matched to the user's library, the built-in database or
//                               USDA (online); per-100 g values come from there, not from the model.
//   5. Cross-checks           – cooking method adds fat/carb deltas to plain base foods, and the model's
//                               calorie estimate nudges mixed dishes richer/lighter (bounded ±25%).

import { chat, extractJSON, compressImage, imagePart, modelInfo, MODELS, CloudError, RETRYABLE, modelChain } from './cloud.js';
import { BUILTIN_FOODS } from './fooddb.js';
import { allFoods, getSettings, saveSettings } from './store.js';
import { searchUSDA } from './api.js';
import { PREPS } from './ai.js';
import { clamp, round } from './util.js';

// ---------- Text matching ----------
const STOP = new Set(['a', 'an', 'the', 'of', 'with', 'and', 'in', 'on', 'some', 'fresh', 'plain', 'cooked', 'homemade', 'style',
  'piece', 'pieces', 'slice', 'slices', 'serving', 'portion', 'bowl', 'plate', 'cup', 'small', 'large', 'medium', 'side', 'whole']);
const singular = w => (w.length > 4 && w.endsWith('ies') ? `${w.slice(0, -3)}y`
  : w.length > 4 && w.endsWith('oes') ? w.slice(0, -2)
    : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
export const tokens = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w && !STOP.has(w)).map(singular);
function dice(a, b) {
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const t of A) if (B.has(t)) n++;
  return (2 * n) / (A.size + B.size);
}
const coverage = (query, text) => {
  const Q = tokens(query), T = new Set(tokens(text));
  return Q.length ? Q.filter(t => T.has(t)).length / Q.length : 0;
};

function prepFor(cooking = '') {
  const c = cooking.toLowerCase();
  if (/deep|batter|bread|crumb|tempura|katsu|fried/.test(c) && !/stir|pan/.test(c)) return 'fried';
  if (/pan|saut|stir|sear/.test(c)) return 'pan';
  if (/cream|cheese sauce|alfredo|gravy|carbonara/.test(c)) return 'sauce';
  if (/grill|roast|bak|broil|bbq|barbecue|air/.test(c)) return 'grilled';
  if (/steam|boil|poach|raw|plain/.test(c)) return 'plain';
  return null;
}

// ---------- Prompt ----------
const SYSTEM = 'You are a meticulous registered dietitian who estimates food portions from photos. You reply with JSON only.';

function buildPrompt({ hint, library, corrections, second }) {
  return [
    second
      ? 'Second, independent opinion: look at this meal photo again from scratch. First count every separate component, then estimate each weight carefully.'
      : 'Identify every distinct food and drink in this photo and estimate the edible weight of each in grams.',
    '',
    'How to estimate weight:',
    '- Use scale references: dinner plate ≈ 26 cm, side plate ≈ 20 cm, cereal bowl ≈ 15 cm, fork ≈ 19 cm, teaspoon ≈ 13 cm, can 330 ml, adult palm ≈ 9 cm wide.',
    '- Estimate volume first, then convert with typical density (cooked rice/pasta ≈ 0.75 g/ml, leafy salad ≈ 0.1 g/ml, meat or fish ≈ 1.05 g/ml, soups and drinks ≈ 1 g/ml).',
    '- Count discrete items (eggs, slices, nuggets, dumplings, sushi pieces) and multiply by a typical unit weight.',
    '- List visible added fats as their own items when substantial: oil sheen, butter, dressing, mayo, sauces, cheese.',
    '- Give a realistic low/high range. Do not inflate portions; most single servings are 100–400 g per component.',
    hint ? `\nThe user says: "${hint}". Trust it for identity and amounts.` : '',
    library.length ? `\nThe user's saved foods. If one clearly matches an item, put its exact name in "library_match":\n${library.map(n => `- ${n}`).join('\n')}` : '',
    corrections.length ? `\nPast corrections by this user (learn from them):\n${corrections.map(c => `- "${c.seen}"${c.modelGrams ? ` ~${c.modelGrams} g` : ''} was corrected to "${c.used}"${c.grams ? ` ${c.grams} g` : ''}`).join('\n')}` : '',
    '',
    'Reply with ONLY this JSON (no prose, no code fences):',
    '{"is_food":true,"items":[{"name":"grilled chicken breast","search_term":"chicken breast","library_match":null,"grams":150,"grams_low":120,"grams_high":190,"count":null,"cooking":"grilled","confidence":0.8,"kcal":250,"protein":46,"carbs":0,"fat":6,"notes":"skinless, light oil"}],"summary":"one sentence about the meal","image_quality":"good"}',
    'Field rules: "search_term" is a short generic food-database name (no brand, no cooking words unless they change the food, e.g. "fried rice"); "grams" is the edible weight; kcal/protein/carbs/fat are YOUR estimate for that weight; confidence is 0–1; image_quality is good, fair or poor. If no food is visible, reply {"is_food":false,"items":[]}.',
  ].filter(s => s !== '').join('\n');
}

function parseHintGrams(hint) {
  const m = String(hint || '').match(/(\d+(?:[.,]\d+)?)\s*(kg|g|grams?|gr|ml|oz)\b/i);
  if (!m) return null;
  let v = parseFloat(m[1].replace(',', '.'));
  if (/kg/i.test(m[2])) v *= 1000;
  if (/oz/i.test(m[2])) v *= 28.35;
  return v;
}

const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);

function cleanItems(json) {
  if (json?.is_food === false) return [];
  return (json?.items || []).filter(it => it && it.name && num(it.grams) > 0).map(it => ({
    name: String(it.name).slice(0, 80),
    search: String(it.search_term || it.name).slice(0, 60),
    libraryMatch: it.library_match ? String(it.library_match) : null,
    grams: clamp(num(it.grams), 1, 3000),
    low: num(it.grams_low) || null,
    high: num(it.grams_high) || null,
    count: num(it.count) || null,
    cooking: it.cooking ? String(it.cooking).slice(0, 40) : '',
    confidence: clamp(num(it.confidence, 0.6), 0, 1),
    model: { kcal: num(it.kcal), protein: num(it.protein), carbs: num(it.carbs), fat: num(it.fat) },
    notes: it.notes ? String(it.notes).slice(0, 160) : '',
  }));
}

// Merge two independent passes: matched items average, unmatched ones survive only if confident.
function mergePasses(a, b) {
  const used = new Set();
  const out = [];
  let matched = 0;
  for (const x of a) {
    let best = -1, score = 0;
    b.forEach((y, j) => {
      if (used.has(j)) return;
      const s = Math.max(dice(x.name, y.name), dice(x.search, y.search));
      if (s > score) { score = s; best = j; }
    });
    if (best >= 0 && score >= 0.5) {
      const y = b[best];
      used.add(best);
      matched++;
      const agree = 1 - Math.abs(x.grams - y.grams) / (x.grams + y.grams);
      out.push({
        ...x,
        grams: (x.grams + y.grams) / 2,
        low: Math.min(x.low || x.grams, y.low || y.grams),
        high: Math.max(x.high || x.grams, y.high || y.grams),
        confidence: ((x.confidence + y.confidence) / 2) * (0.6 + 0.4 * agree),
        model: Object.fromEntries(Object.keys(x.model).map(k => [k, (x.model[k] + y.model[k]) / 2])),
        passes: 2,
      });
    } else if (x.confidence >= 0.5) out.push({ ...x, confidence: x.confidence * 0.6, passes: 1 });
  }
  b.forEach((y, j) => { if (!used.has(j) && y.confidence >= 0.5) out.push({ ...y, confidence: y.confidence * 0.6, passes: 1 }); });
  return { items: out, agreement: matched / Math.max(1, a.length, b.length) };
}

// ---------- Nutrition injection ----------
async function referenceFoods() {
  const mine = (await allFoods()).filter(f => f.per100?.kcal != null);
  return { mine, builtin: BUILTIN_FOODS };
}

function bestLocal(item, refs) {
  if (item.libraryMatch) {
    const exact = refs.mine.find(f => f.name.toLowerCase() === item.libraryMatch.toLowerCase());
    if (exact) return { food: exact, score: 1, basis: 'library' };
  }
  let best = null;
  const consider = (food, bonus, basis) => {
    const s = Math.max(dice(item.search, food.label || food.name), dice(item.name, food.label || food.name)) + bonus;
    if (!best || s > best.score) best = { food, score: s, basis };
  };
  refs.mine.forEach(f => consider(f, f.source === 'custom' ? 0.08 : 0.03, f.source === 'custom' ? 'library' : 'database'));
  refs.builtin.forEach(f => consider(f, 0, 'database'));
  return best && best.score >= 0.6 ? best : null;
}

async function usdaMatch(item, signal) {
  if (!navigator.onLine) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  signal?.addEventListener('abort', () => ctrl.abort());
  try {
    const list = await searchUSDA(item.search, ctrl.signal);
    const ranked = list
      .map(f => ({ f, c: coverage(item.search, f.name), len: tokens(f.name).length }))
      .filter(x => x.c >= 0.99 && x.f.per100?.kcal != null)
      .sort((a, b) => a.len - b.len);
    return ranked[0] ? { food: ranked[0].f, score: 0.7, basis: 'usda' } : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

const DENSITY_CATS = new Set(['dish', 'asian', 'salad', 'soup', 'breakfast', 'dessert']);

export function groundWith(item, match) {
  const g = item.grams;
  const modelPer100 = g > 0 && item.model.kcal > 0
    ? { kcal: (item.model.kcal / g) * 100, protein: (item.model.protein / g) * 100, carbs: (item.model.carbs / g) * 100, fat: (item.model.fat / g) * 100 }
    : null;
  let per100, basis, food, adjust = null, prepId = null;

  if (match) {
    food = match.food;
    basis = match.basis;
    per100 = { ...food.per100 };
    // Cooking method on plain base foods (chicken, fish, veg, potatoes…)
    if (food.adj) {
      prepId = prepFor(item.cooking);
      const pr = PREPS.find(p => p.id === prepId);
      if (pr) {
        per100.protein = (per100.protein || 0) + (pr.d.protein || 0);
        per100.carbs = (per100.carbs || 0) + (pr.d.carbs || 0);
        per100.fat = (per100.fat || 0) + (pr.d.fat || 0);
        per100.kcal += (pr.d.protein || 0) * 4 + (pr.d.carbs || 0) * 4 + (pr.d.fat || 0) * 9;
      }
    }
    // Calorie-density cross-check for mixed dishes: the model saw how rich this plate is.
    if (modelPer100 && (DENSITY_CATS.has(food.category) || basis === 'usda') && per100.kcal > 0) {
      const ratio = modelPer100.kcal / per100.kcal;
      const k = clamp(1 + (ratio - 1) * 0.5, 0.8, 1.25);
      if (Math.abs(k - 1) >= 0.04) {
        const fat0 = per100.fat || 0, carb0 = per100.carbs || 0;
        per100.fat = fat0 * k;
        per100.carbs = carb0 * (1 + (k - 1) * 0.5);
        per100.kcal += (per100.fat - fat0) * 9 + (per100.carbs - carb0) * 4;
        adjust = k;
      }
    }
  } else if (modelPer100) {
    basis = 'model';
    per100 = modelPer100;
  } else {
    return null;
  }

  const dbKcal = match && food.per100?.kcal;
  const check = !!(modelPer100 && dbKcal && Math.abs(modelPer100.kcal - dbKcal) / Math.max(modelPer100.kcal, dbKcal) > 0.6);
  per100 = Object.fromEntries(Object.entries(per100).filter(([, v]) => Number.isFinite(v)).map(([k, v]) => [k, round(v, 2)]));
  return {
    ...item,
    food: {
      id: food?.id || `ai:${tokens(item.name).join('-') || 'food'}`,
      name: food ? food.name : item.name.replace(/\b\w/g, c => c.toUpperCase()),
      brand: food?.brand || '',
      emoji: food?.emoji || '🍽️',
      image: food?.image || '',
      source: food?.source || 'ai',
      category: food?.category,
      adj: !!food?.adj,
      servings: food?.servings || [],
      per100,
    },
    basis,
    prepId,
    adjust,
    check,
  };
}

/**
 * Estimate a meal photo with the cloud vision model.
 * Returns { items, summary, confidence, score, model, passes, agreement, thumb, imageQuality }.
 */
export async function estimateMealCloud(file, { hint = '', onStep = () => {}, signal } = {}) {
  onStep('prepare');
  const { dataUrl, thumb } = await compressImage(file, 1024, 0.82);
  const s = getSettings();
  const refs = await referenceFoods();
  const library = refs.mine
    .filter(f => f.source === 'custom' || f.favorite)
    .sort((a, b) => (b.uses || 0) - (a.uses || 0))
    .slice(0, 30)
    .map(f => (f.brand ? `${f.name} (${f.brand})` : f.name));
  const corrections = (s.ai.corrections || []).slice(-12);
  const effort = s.ai.effort;
  const maxTokens = effort === 'fast' ? 2500 : 7000;

  // Try the chosen vision model, then other vision models if it's unavailable.
  const order = modelChain(s.ai.visionModel, MODELS.filter(m => m.vision).map(m => m.id));
  let model = null, passes = [], summary = '', imageQuality = '';
  const run = async (id, second) => {
    const messages = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: [{ type: 'text', text: buildPrompt({ hint, library, corrections, second }) }, imagePart(dataUrl)] },
    ];
    let chars = 0;
    const r = await chat({
      model: id, messages, signal, maxTokens, temperature: second ? 0.8 : undefined,
      onWait: s => { if (s >= 4) onStep('vision', { model: id, waiting: s }); },
      onDelta: d => { const n = (d.content?.length || 0) + (d.thought?.length || 0); if (n - chars > 200) { chars = n; onStep('vision', { model: id, chars: n, thinking: !d.content }); } },
    });
    try {
      return extractJSON(r.content);
    } catch {
      const fix = await chat({ model: id, signal, stream: false, maxTokens: 3000, effort: 'fast', messages: [...messages, { role: 'assistant', content: r.content || '(empty)' }, { role: 'user', content: 'That reply was not valid JSON. Reply again with ONLY the JSON object in the requested shape.' }] });
      return extractJSON(fix.content);
    }
  };

  let lastErr;
  for (const id of order) {
    onStep('vision', { model: id });
    try {
      const jobs = [run(id, false)];
      if (s.ai.accuracy === 'high') jobs.push(run(id, true));
      const settled = await Promise.allSettled(jobs);
      const ok = settled.filter(p => p.status === 'fulfilled').map(p => p.value);
      if (!ok.length) throw settled[0].reason;
      passes = ok.map(cleanItems);
      summary = String(ok[0].summary || '').slice(0, 240);
      imageQuality = String(ok[0].image_quality || '');
      model = id;
      break;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      lastErr = e;
      // Only fall through to another model when this one is unavailable or broken.
      if (!(e instanceof CloudError) || !(RETRYABLE.has(e.status) || e.status === 400 || e.status === 422)) throw e;
    }
  }
  if (!model) throw lastErr || new CloudError('No vision model answered.');

  onStep('ground');
  let { items, agreement } = passes.length === 2 ? mergePasses(passes[0], passes[1]) : { items: passes[0], agreement: 1 };
  const hintGrams = parseHintGrams(hint);
  if (hintGrams && items.length === 1) items[0].grams = hintGrams;

  const grounded = await Promise.all(items.map(async it => {
    const match = bestLocal(it, refs) || (await usdaMatch(it, signal));
    return groundWith({ ...it, grams: Math.round(it.grams / 5) * 5 || it.grams }, match);
  }));
  const final = grounded.filter(Boolean);

  const totalKcal = final.reduce((acc, it) => acc + (it.food.per100.kcal * it.grams) / 100, 0) || 1;
  let score = final.reduce((acc, it) => acc + it.confidence * ((it.food.per100.kcal * it.grams) / 100 / totalKcal), 0);
  if (passes.length === 2) score *= 0.7 + 0.3 * agreement;
  const confidence = !final.length ? 'low' : score >= 0.7 ? 'high' : score >= 0.45 ? 'medium' : 'low';
  onStep('done');
  return { items: final, model, modelLabel: modelInfo(model).label, passes: passes.length, agreement, score, confidence, thumb, dataUrl, summary, imageQuality };
}

// Remember what the user changed so the next prompt includes it.
export async function learnCorrections(pairs) {
  const changed = pairs.filter(({ before, after }) =>
    before && (before.food.id !== after.food.id || Math.abs(after.grams - before.grams) / before.grams > 0.25));
  if (!changed.length) return;
  const list = [...(getSettings().ai.corrections || [])];
  for (const { before, after } of changed) {
    list.push({ seen: before.name, modelGrams: Math.round(before.grams), used: after.food.name, grams: Math.round(after.grams), at: Date.now() });
  }
  await saveSettings({ ai: { corrections: list.slice(-30) } });
}
