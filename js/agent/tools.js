// Coach tools: everything the agent may read or change in the user's diary and food library.
// Each tool: { name, risk: 'read' | 'write' | 'destructive', description, parameters, preview?, run }.
// run() returns { result, card: { icon, title, detail }, undo? }. Results are compact JSON for the model.

import * as store from '../store.js';
import { scale, sum, calcTargets, kgToLb, lbToKg, DIETS } from '../nutrition.js';
import { builtinById, searchBuiltin } from '../fooddb.js';
import { searchOFF, searchUSDA, lookupBarcode } from '../api.js';
import { estimateMealCloud, tokens } from '../vision.js';
import { checkGoals } from '../celebrate.js';
import { todayKey, addDays, isKey, mealForNow, mealName, MEALS, uid, round, fmt } from '../util.js';

const r1 = v => Math.round((+v || 0) * 10) / 10;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const MEAL_IDS = MEALS.map(m => m.id);

function normDate(d) {
  const t = todayKey();
  if (!d || d === 'today') return t;
  if (d === 'yesterday') return addDays(t, -1);
  if (d === 'tomorrow') return addDays(t, 1);
  if (isKey(d)) return d;
  throw new Error(`Invalid date "${d}" — use YYYY-MM-DD`);
}
function normMeal(m) {
  if (!m) return mealForNow();
  const k = String(m).toLowerCase().trim();
  if (k.startsWith('snack')) return 'snacks';
  if (MEAL_IDS.includes(k)) return k;
  throw new Error(`Unknown meal "${m}" — use breakfast, lunch, dinner or snacks`);
}

const macros = n => ({ kcal: Math.round(n.kcal || 0), protein: r1(n.protein), carbs: r1(n.carbs), fat: r1(n.fat), fiber: r1(n.fiber) });
const compactEntry = e => ({ entry_id: e.id, meal: e.meal, name: e.name, grams: e.grams ? r1(e.grams) : undefined, ...macros(e), source: e.source });
const compactFood = f => ({
  food_id: f.id,
  name: f.name,
  brand: f.brand || undefined,
  source: f.source,
  per_100g: f.per100 ? macros(f.per100) : undefined,
  servings: (f.servings || []).map(s => ({ label: s.label, grams: s.grams })),
  favorite: f.favorite || undefined,
});

const QUALIFIERS = new Set(['a', 'an', 'one', 'two', 'three', 'some', 'my', 'the', 'of', 'medium', 'large', 'small', 'big', 'fresh',
  'whole', 'piece', 'pieces', 'slice', 'slices', 'cup', 'cups', 'serving', 'servings', 'portion', 'bowl', 'plate', 'g', 'gram', 'grams', 'ml']);
const coreQuery = q => q.toLowerCase().replace(/\d+([.,]\d+)?/g, ' ').split(/[^a-z'-]+/).filter(w => w && !QUALIFIERS.has(w)).join(' ') || q.toLowerCase();

// Prefer the plain food over processed variants ("Banana, raw" before "Banana chips") unless asked for.
const PROCESSED = /\b(chips?|dried|dehydrated|powder|nectar|juice|canned|syrup|candied|frozen|baby food|flavou?red|imitation)\b/i;
function rankPlain(list, q) {
  const qt = tokens(q);
  return list
    .map((f, i) => {
      const name = f.name.toLowerCase();
      const cover = qt.length ? qt.filter(t => tokens(name).includes(t)).length / qt.length : 0;
      const processed = PROCESSED.test(name) && !PROCESSED.test(q);
      return { f, s: cover * 2 + (/\braw\b/.test(name) ? 0.6 : 0) - (processed ? 1.5 : 0) - name.length / 200 - i * 0.01 };
    })
    .sort((a, b) => b.s - a.s)
    .map(x => x.f);
}

async function resolveFood(id, ctx) {
  if (!id) return null;
  return ctx.foods.get(id) || (await store.getFood(id)) || builtinById.get(id) || null;
}

function entryFor(food, grams, { meal, date, qty, unit, unitGrams }) {
  const n = scale(food.per100, grams);
  return {
    date, meal, foodId: food.id, name: food.name, brand: food.brand || '', emoji: food.emoji || '', image: food.image || '',
    source: food.source || 'custom', per100: food.per100, grams: r1(grams), qty: qty ?? r1(grams), unit: unit || 'g', unitGrams: unitGrams || 1,
    kcal: 0, protein: 0, carbs: 0, fat: 0,
    ...Object.fromEntries(Object.entries(n).map(([k, v]) => [k, r1(v)])),
    via: 'coach',
  };
}

async function dayTotals(date) {
  const entries = await store.getEntries(date);
  const t = sum(entries);
  const tg = store.getSettings().targets;
  return { entries, totals: macros(t), remaining: { kcal: Math.round(tg.kcal - t.kcal), protein: r1(tg.protein - t.protein), carbs: r1(tg.carbs - t.carbs), fat: r1(tg.fat - t.fat) } };
}

const ACTIVITY_KEYS = { sedentary: 1.2, light: 1.375, moderate: 1.55, very: 1.725, athlete: 1.9 };
const activityName = v => Object.entries(ACTIVITY_KEYS).find(([, x]) => x === +v)?.[0] || String(v);

export const TOOLS = [
  // ---------------- Read ----------------
  {
    name: 'get_overview', risk: 'read',
    description: "The user's profile, goal, daily targets, and today's totals and remaining amounts.",
    parameters: { type: 'object', properties: {} },
    async run() {
      const s = store.getSettings();
      const t = await dayTotals(todayKey());
      const weights = await store.getWeights();
      const day = await store.getDay(todayKey());
      return {
        result: {
          name: s.name || undefined, units: s.units,
          profile: { ...s.profile, activity: activityName(s.profile.activity) },
          targets: s.targets, today: todayKey(), today_totals: t.totals, today_remaining: t.remaining,
          today_water_ml: day.water || 0, latest_weight: weights.at(-1) || null, streak_days: await store.getStreak(),
        },
        card: { icon: 'user', title: 'Read your profile & today' },
      };
    },
  },
  {
    name: 'get_diary', risk: 'read',
    description: 'All diary entries for one day (with entry_ids needed to edit or delete), plus totals, remaining vs targets and water.',
    parameters: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD, "today" or "yesterday". Default today.' } } },
    async run({ date }) {
      const d = normDate(date);
      const t = await dayTotals(d);
      const day = await store.getDay(d);
      return {
        result: { date: d, entries: t.entries.map(compactEntry), totals: t.totals, remaining: t.remaining, water_ml: day.water || 0 },
        card: { icon: 'book', title: `Read diary · ${d === todayKey() ? 'today' : d}`, detail: `${plural(t.entries.length, 'entry', 'entries')} · ${fmt(t.totals.kcal)} kcal` },
      };
    },
  },
  {
    name: 'get_history', risk: 'read',
    description: 'Per-day calorie/macro totals, water and weigh-ins for a date range (max 92 days), with averages over logged days.',
    parameters: { type: 'object', properties: { from: { type: 'string', description: 'YYYY-MM-DD' }, to: { type: 'string', description: 'YYYY-MM-DD, default today' } }, required: ['from'] },
    async run({ from, to }) {
      const a = normDate(from), b = normDate(to);
      if (b < a) throw new Error('"to" is before "from"');
      const [entries, days, weights] = await Promise.all([store.getEntriesRange(a, b), store.getDaysRange(a, b), store.getWeights()]);
      const out = [];
      for (let d = a, i = 0; d <= b && i < 92; d = addDays(d, 1), i++) {
        const list = entries.filter(e => e.date === d);
        out.push({ date: d, entries: list.length, ...macros(sum(list)), water_ml: days.find(x => x.date === d)?.water || 0 });
      }
      const logged = out.filter(x => x.entries);
      const avg = k => (logged.length ? Math.round(logged.reduce((s, x) => s + x[k], 0) / logged.length) : 0);
      return {
        result: { days: out, logged_days: logged.length, averages: { kcal: avg('kcal'), protein: avg('protein'), carbs: avg('carbs'), fat: avg('fat') }, weights: weights.filter(w => w.date >= a && w.date <= b), targets: store.getSettings().targets },
        card: { icon: 'chart', title: `Read history ${a} → ${b}`, detail: `${logged.length} logged days` },
      };
    },
  },
  {
    name: 'search_foods', risk: 'read',
    description: "Search the user's saved foods, the built-in generic database, and (online) Open Food Facts branded products and USDA generic foods. Returns food_ids with per-100 g macros and serving sizes.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Food name, e.g. "greek yogurt" or "chobani vanilla"' },
        online: { type: 'boolean', description: 'Also search Open Food Facts and USDA (default true)' },
      },
      required: ['query'],
    },
    async run({ query, online = true }, ctx) {
      const raw = String(query || '').trim();
      if (!raw) throw new Error('Empty query');
      // "a medium banana" → "banana": sizes and counts belong in grams/servings, not the search.
      const q = coreQuery(raw);
      const terms = q.split(/\s+/);
      const saved = (await store.allFoods())
        .filter(f => terms.every(t => `${f.name} ${f.brand || ''}`.toLowerCase().includes(t)))
        .sort((a, b) => (b.source === 'custom') - (a.source === 'custom') || (b.uses || 0) - (a.uses || 0))
        .slice(0, 6);
      const generic = searchBuiltin(q, 6).filter(f => !saved.some(s => s.id === f.id));
      let off = [], usda = [], errors = [];
      if (online && navigator.onLine) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 9000);
        ctx.signal?.addEventListener('abort', () => ctrl.abort());
        const [o, u] = await Promise.allSettled([searchOFF(q, ctrl.signal), searchUSDA(q, ctrl.signal)]);
        clearTimeout(timer);
        if (o.status === 'fulfilled') off = o.value.slice(0, 6); else errors.push('Open Food Facts unavailable');
        if (u.status === 'fulfilled') usda = rankPlain(u.value, q).slice(0, 5); else errors.push('USDA unavailable');
      }
      const all = [...saved, ...generic, ...off, ...usda];
      all.forEach(f => ctx.foods.set(f.id, f));
      // Explicit pick for smaller models: the user's own food, else the plain generic, else plain USDA.
      const best = saved.find(f => tokens(f.name).some(t => terms.includes(t))) || generic[0] || usda[0] || off[0];
      return {
        result: {
          query: raw, searched_for: q,
          best_match: best ? compactFood(best) : null,
          your_foods: saved.map(compactFood), generic: generic.map(compactFood), branded_open_food_facts: off.map(compactFood), usda: usda.map(compactFood),
          notes: errors.length ? errors : undefined,
        },
        card: { icon: 'search', title: `Searched “${q}”`, detail: plural(all.length, 'result') },
      };
    },
  },
  {
    name: 'get_food', risk: 'read',
    description: 'Full details for one food_id (nutrition per 100 g, servings, brand).',
    parameters: { type: 'object', properties: { food_id: { type: 'string' } }, required: ['food_id'] },
    async run({ food_id }, ctx) {
      const f = await resolveFood(food_id, ctx);
      if (!f) throw new Error(`No food with id ${food_id}. Search first.`);
      return { result: { ...compactFood(f), per_100g_full: f.per100, barcode: f.barcode, ingredients: f.ingredients }, card: { icon: 'info', title: `Looked at ${f.name}` } };
    },
  },
  {
    name: 'lookup_barcode', risk: 'read',
    description: 'Look up a product barcode (EAN/UPC) in the user’s foods, Open Food Facts and USDA.',
    parameters: { type: 'object', properties: { barcode: { type: 'string' } }, required: ['barcode'] },
    async run({ barcode }, ctx) {
      const r = await lookupBarcode(String(barcode), { signal: ctx.signal });
      if (!r) return { result: { found: false, barcode }, card: { icon: 'scan', title: `Barcode ${barcode} not found` } };
      ctx.foods.set(r.food.id, r.food);
      return { result: { found: true, from: r.from, food: compactFood(r.food) }, card: { icon: 'scan', title: `Found ${r.food.name}`, detail: r.from } };
    },
  },
  {
    name: 'list_my_foods', risk: 'read',
    description: "List the user's library: custom foods they created, favourites, or recently used foods.",
    parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['custom', 'favorites', 'recent'] }, limit: { type: 'integer', description: 'Default 20' } }, required: ['kind'] },
    async run({ kind, limit = 20 }, ctx) {
      const foods = await store.allFoods();
      const list = kind === 'custom' ? foods.filter(f => f.source === 'custom').sort((a, b) => a.name.localeCompare(b.name))
        : kind === 'favorites' ? foods.filter(f => f.favorite)
          : foods.filter(f => f.lastUsed).sort((a, b) => b.lastUsed - a.lastUsed);
      const out = list.slice(0, Math.min(50, limit));
      out.forEach(f => ctx.foods.set(f.id, f));
      return { result: { kind, count: list.length, foods: out.map(compactFood) }, card: { icon: 'database', title: `Listed ${kind} foods`, detail: `${list.length} total` } };
    },
  },
  {
    name: 'analyze_photo', risk: 'read',
    description: 'Analyse a meal photo the user attached with the vision model. Returns each item with a food_id (loggable with log_food), estimated grams with a range, and database-grounded macros.',
    parameters: { type: 'object', properties: { photo: { type: 'integer', description: '1-based index of the attached photo; default the most recent' }, hint: { type: 'string', description: 'What the user said about the meal, amounts etc.' } } },
    async run({ photo, hint }, ctx) {
      const img = photo ? ctx.images[photo - 1] : ctx.images.at(-1);
      if (!img) throw new Error('No photo attached in this conversation. Ask the user to attach one.');
      const blob = await (await fetch(img.dataUrl)).blob();
      const r = await estimateMealCloud(blob, { hint, signal: ctx.signal });
      const n = ctx.images.indexOf(img) + 1;
      const items = r.items.map((it, i) => {
        const id = `photo${n}:${i + 1}`;
        ctx.foods.set(id, { ...it.food, id, image: img.thumb, matchedId: it.food.id });
        const m = scale(it.food.per100, it.grams);
        return { food_id: id, name: it.food.name, seen_as: it.name, grams: Math.round(it.grams), grams_range: [Math.round(it.low || it.grams * 0.8), Math.round(it.high || it.grams * 1.2)], cooking: it.cooking || undefined, ...macros(m), nutrition_from: it.basis, confidence: round(it.confidence, 2), check: it.check || undefined };
      });
      return {
        result: { photo: n, model: r.modelLabel, confidence: r.confidence, passes: r.passes, items, total: macros(sum(items)) },
        card: { icon: 'sparkles', title: `Analysed photo ${n}`, detail: `${items.length} items · ${fmt(sum(items).kcal)} kcal · ${r.confidence} confidence` },
      };
    },
  },

  // ---------------- Write ----------------
  {
    name: 'log_food', risk: 'write',
    description: 'Add a food to the diary by food_id (from search_foods, list_my_foods, lookup_barcode or analyze_photo). Give grams, or servings (multiples of the food’s first serving size).',
    parameters: {
      type: 'object',
      properties: {
        food_id: { type: 'string' },
        grams: { type: 'number' },
        servings: { type: 'number' },
        meal: { type: 'string', enum: MEAL_IDS },
        date: { type: 'string', description: 'YYYY-MM-DD, default today' },
      },
      required: ['food_id'],
    },
    async preview({ food_id, grams, servings, meal, date }, ctx) {
      const f = await resolveFood(food_id, ctx);
      return `Log ${f?.name || food_id}${grams ? ` · ${fmt(grams)} g` : servings ? ` · ${servings} serving(s)` : ''} to ${mealName(normMeal(meal))}, ${normDate(date)}`;
    },
    async run({ food_id, grams, servings, meal, date }, ctx) {
      const food = await resolveFood(food_id, ctx);
      if (!food) throw new Error(`Unknown food_id ${food_id}. Use search_foods first.`);
      if (!food.per100 || food.per100.kcal == null) throw new Error('That food has no nutrition data; use quick_add instead.');
      const sv = food.servings?.[0];
      let g = +grams;
      let unit = 'g', unitGrams = 1, qty;
      if (!(g > 0) && servings > 0) {
        if (!sv) throw new Error('This food has no serving size; give grams instead.');
        g = servings * sv.grams; unit = sv.label; unitGrams = sv.grams; qty = servings;
      }
      if (!(g > 0)) g = sv?.grams || 100;
      if (g > 5000) throw new Error('Amount looks wrong (over 5 kg).');
      const d = normDate(date), m = normMeal(meal);
      // Photo items carry grounded (cooking/density-adjusted) values: log them as AI entries and never
      // write those adjusted numbers back into the library.
      const fromPhoto = String(food_id).startsWith('photo');
      const base = fromPhoto ? { ...food, id: food.matchedId || food.id, source: 'ai' } : food;
      const entry = await store.addEntry(entryFor(base, g, { meal: m, date: d, qty: qty ?? r1(g), unit, unitGrams }));
      if (!fromPhoto) await store.touchFood(food).catch(() => {});
      checkGoals(d);
      return {
        result: { logged: compactEntry(entry), date: d },
        card: { icon: 'plus', title: `Logged ${entry.name}`, detail: `${fmt(entry.grams)} g · ${fmt(entry.kcal)} kcal · ${mealName(m)}${d !== todayKey() ? ` · ${d}` : ''}` },
        undo: () => store.deleteEntry(entry.id),
      };
    },
  },
  {
    name: 'log_food_by_name', risk: 'write',
    description: 'Fastest way to log a food: finds the best match for a plain food name (your foods first, then generic, then USDA/Open Food Facts) and logs it in one step. Use this for everyday foods; call it several times in one turn for several foods. If the match is uncertain it returns candidates instead of logging.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Plain food name, e.g. "banana", "greek yogurt", "white rice"' },
        grams: { type: 'number' },
        servings: { type: 'number', description: 'Multiples of the food’s standard serving (e.g. 1 = one medium banana)' },
        meal: { type: 'string', enum: MEAL_IDS },
        date: { type: 'string', description: 'YYYY-MM-DD, default today' },
      },
      required: ['name'],
    },
    preview: ({ name, grams, servings, meal }) => `Log ${name}${grams ? ` · ${fmt(grams)} g` : servings ? ` · ${servings} serving(s)` : ''} to ${mealName(normMeal(meal))}`,
    async run(args, ctx) {
      const q = coreQuery(String(args.name || ''));
      if (!q) throw new Error('Give a food name');
      const terms = q.split(/\s+/);
      const saved = (await store.allFoods()).filter(f => f.per100?.kcal != null && terms.every(t => `${f.name} ${f.brand || ''}`.toLowerCase().includes(t)))
        .sort((a, b) => (b.source === 'custom') - (a.source === 'custom') || (b.uses || 0) - (a.uses || 0));
      let food = saved[0] || searchBuiltin(q, 1)[0];
      let candidates = [];
      if (!food && navigator.onLine) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 9000);
        const [u, o] = await Promise.allSettled([searchUSDA(q, ctrl.signal), searchOFF(q, ctrl.signal)]);
        clearTimeout(timer);
        const usda = u.status === 'fulfilled' ? rankPlain(u.value, q) : [];
        const off = o.status === 'fulfilled' ? o.value : [];
        candidates = [...usda.slice(0, 4), ...off.slice(0, 4)];
        candidates.forEach(f => ctx.foods.set(f.id, f));
        // Only auto-pick when the top USDA result covers every word of the name and isn't processed.
        const top = usda[0];
        if (top && tokens(q).every(t => tokens(top.name).includes(t)) && !PROCESSED.test(top.name)) food = top;
      }
      if (!food) {
        return {
          result: { logged: false, reason: 'No confident match', candidates: candidates.map(compactFood), next: 'Pick a candidate and call log_food with its food_id, or quick_add an estimate.' },
          card: { icon: 'search', title: `No exact match for “${q}”`, detail: plural(candidates.length, 'candidate') },
        };
      }
      ctx.foods.set(food.id, food);
      const out = await toolByName.get('log_food').run({ food_id: food.id, grams: args.grams, servings: args.servings, meal: args.meal, date: args.date }, ctx);
      out.result.matched = { food_id: food.id, name: food.name, source: food.source };
      return out;
    },
  },
  {
    name: 'list_saved_meals', risk: 'read',
    description: "The user's saved meals (reusable groups of foods, e.g. 'My usual breakfast') with their items and calories.",
    parameters: { type: 'object', properties: {} },
    async run() {
      const meals = await store.allMeals();
      return {
        result: { meals: meals.map(m => ({ meal_id: m.id, name: m.name, kcal: m.kcal, items: m.items.map(i => `${i.name}${i.grams ? ` ${r1(i.grams)} g` : ''}`), times_used: m.uses || 0 })) },
        card: { icon: 'star', title: 'Read saved meals', detail: plural(meals.length, 'meal') },
      };
    },
  },
  {
    name: 'log_saved_meal', risk: 'write',
    description: 'Log every food of a saved meal in one step. factor scales the portions (0.5 = half, 2 = double).',
    parameters: { type: 'object', properties: { meal_id: { type: 'string' }, meal: { type: 'string', enum: MEAL_IDS }, date: { type: 'string' }, factor: { type: 'number' } }, required: ['meal_id'] },
    async preview({ meal_id, meal }) { const m = await store.getMeal(meal_id); return `Log saved meal “${m?.name || meal_id}” to ${mealName(normMeal(meal))}`; },
    async run({ meal_id, meal, date, factor = 1 }) {
      const saved = await store.getMeal(meal_id);
      if (!saved) throw new Error(`No saved meal ${meal_id}. Use list_saved_meals.`);
      if (!(factor > 0 && factor <= 5)) throw new Error('factor must be between 0 and 5');
      const d = normDate(date), m = normMeal(meal);
      const added = await store.logMeal(saved, { date: d, meal: m, factor });
      checkGoals(d);
      const kcal = added.reduce((s, e) => s + (e.kcal || 0), 0);
      return {
        result: { logged: added.map(compactEntry), total_kcal: Math.round(kcal) },
        card: { icon: 'star', title: `Logged ${saved.name}`, detail: `${plural(added.length, 'item')} · ${fmt(kcal)} kcal · ${mealName(m)}` },
        undo: async () => { for (const a of added) await store.deleteEntry(a.id); },
      };
    },
  },
  {
    name: 'save_meal', risk: 'write',
    description: 'Save the foods currently in one meal of a day as a reusable saved meal.',
    parameters: { type: 'object', properties: { name: { type: 'string' }, meal: { type: 'string', enum: MEAL_IDS }, date: { type: 'string' } }, required: ['name', 'meal'] },
    preview: ({ name, meal }) => `Save today's ${mealName(normMeal(meal)).toLowerCase()} as “${name}”`,
    async run({ name, meal, date }) {
      const m = normMeal(meal);
      const list = (await store.getEntries(normDate(date))).filter(e => e.meal === m);
      if (!list.length) throw new Error('That meal is empty.');
      const saved = await store.saveMeal({ name: String(name).slice(0, 40), emoji: MEALS.find(x => x.id === m)?.emoji, items: list.map(store.mealItemFrom) });
      return { result: { saved: { meal_id: saved.id, name: saved.name, kcal: saved.kcal, items: list.length } }, card: { icon: 'star', title: `Saved “${saved.name}”`, detail: `${plural(list.length, 'item')} · ${fmt(saved.kcal)} kcal` }, undo: () => store.deleteMeal(saved.id) };
    },
  },
  {
    name: 'quick_add', risk: 'write',
    description: 'Log calories/macros directly when no database food fits (restaurant meals, recipes). Use careful estimates.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' }, kcal: { type: 'number' }, protein: { type: 'number' }, carbs: { type: 'number' }, fat: { type: 'number' }, fiber: { type: 'number' },
        meal: { type: 'string', enum: MEAL_IDS }, date: { type: 'string' },
      },
      required: ['name', 'kcal'],
    },
    preview: ({ name, kcal, meal }) => `Quick add “${name}” · ${fmt(kcal)} kcal to ${mealName(normMeal(meal))}`,
    async run({ name, kcal, protein = 0, carbs = 0, fat = 0, fiber, meal, date }) {
      if (!(kcal >= 0 && kcal < 10000)) throw new Error('kcal must be between 0 and 10000');
      const d = normDate(date), m = normMeal(meal);
      const entry = await store.addEntry({ date: d, meal: m, name: String(name).slice(0, 80), kcal: Math.round(kcal), protein: r1(protein), carbs: r1(carbs), fat: r1(fat), ...(fiber != null ? { fiber: r1(fiber) } : {}), emoji: '⚡', source: 'quick', grams: 0, via: 'coach' });
      checkGoals(d);
      return { result: { logged: compactEntry(entry) }, card: { icon: 'zap', title: `Quick-added ${entry.name}`, detail: `${fmt(entry.kcal)} kcal · ${mealName(m)}` }, undo: () => store.deleteEntry(entry.id) };
    },
  },
  {
    name: 'update_entry', risk: 'write',
    description: 'Change a diary entry’s amount (grams), meal or date. Macros are recalculated from the food’s per-100 g values.',
    parameters: { type: 'object', properties: { entry_id: { type: 'string' }, grams: { type: 'number' }, meal: { type: 'string', enum: MEAL_IDS }, date: { type: 'string' } }, required: ['entry_id'] },
    async preview({ entry_id, grams, meal, date }) {
      const e = await store.getEntry(entry_id);
      return `Change ${e?.name || 'entry'}${grams ? ` to ${fmt(grams)} g` : ''}${meal ? ` → ${mealName(meal)}` : ''}${date ? ` → ${date}` : ''}`;
    },
    async run({ entry_id, grams, meal, date }) {
      const prev = await store.getEntry(entry_id);
      if (!prev) throw new Error(`No entry ${entry_id}. Use get_diary for ids.`);
      const next = { ...prev };
      if (meal) next.meal = normMeal(meal);
      if (date) next.date = normDate(date);
      if (grams > 0) {
        if (prev.source === 'quick' || !prev.per100) throw new Error('Quick-add entries have no per-100 g data; delete and quick_add again instead.');
        Object.assign(next, Object.fromEntries(Object.entries(scale(prev.per100, grams)).map(([k, v]) => [k, r1(v)])));
        next.grams = r1(grams);
        next.qty = next.unitGrams ? r1(grams / next.unitGrams) : r1(grams);
      }
      await store.updateEntry(next);
      checkGoals(next.date);
      return { result: { updated: compactEntry(next) }, card: { icon: 'edit', title: `Updated ${next.name}`, detail: `${fmt(next.grams || 0)} g · ${fmt(next.kcal)} kcal · ${mealName(next.meal)}` }, undo: () => store.updateEntry(prev) };
    },
  },
  {
    name: 'delete_entry', risk: 'destructive',
    description: 'Remove a diary entry by entry_id.',
    parameters: { type: 'object', properties: { entry_id: { type: 'string' } }, required: ['entry_id'] },
    async preview({ entry_id }) {
      const e = await store.getEntry(entry_id);
      return e ? `Delete “${e.name}” (${fmt(e.kcal)} kcal) from ${mealName(e.meal)}, ${e.date}` : `Delete entry ${entry_id}`;
    },
    async run({ entry_id }) {
      const removed = await store.deleteEntry(entry_id);
      if (!removed) throw new Error(`No entry ${entry_id}`);
      return { result: { deleted: compactEntry(removed) }, card: { icon: 'trash', title: `Deleted ${removed.name}`, detail: `${fmt(removed.kcal)} kcal` }, undo: () => store.addEntry(removed) };
    },
  },
  {
    name: 'copy_meal', risk: 'write',
    description: 'Copy every entry of one meal from one day to another (e.g. same breakfast as yesterday).',
    parameters: { type: 'object', properties: { from_date: { type: 'string' }, to_date: { type: 'string' }, meal: { type: 'string', enum: MEAL_IDS }, to_meal: { type: 'string', enum: MEAL_IDS } }, required: ['from_date', 'meal'] },
    preview: ({ from_date, to_date, meal, to_meal }) => `Copy ${mealName(normMeal(meal))} from ${normDate(from_date)} to ${mealName(normMeal(to_meal || meal))}, ${normDate(to_date)}`,
    async run({ from_date, to_date, meal, to_meal }) {
      const m = normMeal(meal), tm = normMeal(to_meal || meal), d = normDate(to_date);
      const src = (await store.getEntries(normDate(from_date))).filter(e => e.meal === m);
      if (!src.length) throw new Error('Nothing logged in that meal.');
      const added = await store.addEntries(src.map(({ id, createdAt, ...rest }) => ({ ...rest, date: d, meal: tm, via: 'coach' })));
      checkGoals(d);
      return { result: { copied: added.map(compactEntry) }, card: { icon: 'copy', title: `Copied ${added.length} item${added.length > 1 ? 's' : ''}`, detail: `${mealName(tm)} · ${d}` }, undo: async () => { for (const a of added) await store.deleteEntry(a.id); } };
    },
  },
  {
    name: 'create_food', risk: 'write',
    description: "Save a custom food to the user's library (e.g. from a nutrition label or recipe). Values are per serving or per 100 g as stated by 'per'.",
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' }, brand: { type: 'string' }, per: { type: 'string', enum: ['serving', '100g'] },
        serving_label: { type: 'string', description: 'e.g. "1 bar", "1 cup"' }, serving_grams: { type: 'number' },
        kcal: { type: 'number' }, protein: { type: 'number' }, carbs: { type: 'number' }, fat: { type: 'number' },
        fiber: { type: 'number' }, sugar: { type: 'number' }, sat_fat: { type: 'number' }, sodium_mg: { type: 'number' },
        barcode: { type: 'string' }, ingredients: { type: 'string' },
      },
      required: ['name', 'per', 'kcal'],
    },
    preview: a => `Create custom food “${a.name}” (${fmt(a.kcal)} kcal per ${a.per === 'serving' ? a.serving_label || 'serving' : '100 g'})`,
    async run(a, ctx) {
      if (a.per === 'serving' && !(a.serving_grams > 0)) throw new Error('serving_grams is required when per = "serving"');
      const f = a.per === 'serving' ? 100 / a.serving_grams : 1;
      const per100 = Object.fromEntries(Object.entries({ kcal: a.kcal, protein: a.protein, carbs: a.carbs, fat: a.fat, fiber: a.fiber, sugar: a.sugar, satFat: a.sat_fat, sodium: a.sodium_mg })
        .filter(([, v]) => v != null && v >= 0).map(([k, v]) => [k, round(v * f, 2)]));
      const food = await store.saveFood({
        id: `custom:${uid()}`, source: 'custom', name: String(a.name).slice(0, 80), brand: a.brand || '', emoji: '🍽️', per100,
        servings: a.serving_grams > 0 ? [{ label: a.serving_label || 'serving', grams: a.serving_grams }] : [],
        barcode: a.barcode ? String(a.barcode).replace(/\D/g, '') : undefined, ingredients: a.ingredients || undefined,
      });
      ctx.foods.set(food.id, food);
      return { result: { created: compactFood(food) }, card: { icon: 'edit', title: `Created ${food.name}`, detail: `${fmt(per100.kcal)} kcal / 100 g` }, undo: () => store.deleteFood(food.id) };
    },
  },
  {
    name: 'update_food', risk: 'destructive',
    description: "Edit one of the user's custom foods (only custom foods can be edited). Nutrition values are per 100 g.",
    parameters: {
      type: 'object',
      properties: {
        food_id: { type: 'string' }, name: { type: 'string' }, brand: { type: 'string' }, serving_label: { type: 'string' }, serving_grams: { type: 'number' },
        kcal: { type: 'number' }, protein: { type: 'number' }, carbs: { type: 'number' }, fat: { type: 'number' }, fiber: { type: 'number' }, sugar: { type: 'number' },
      },
      required: ['food_id'],
    },
    async preview({ food_id }) { const f = await store.getFood(food_id); return `Edit custom food “${f?.name || food_id}”`; },
    async run(a) {
      const prev = await store.getFood(a.food_id);
      if (!prev || prev.source !== 'custom') throw new Error('Only custom foods can be edited.');
      const per100 = { ...prev.per100 };
      for (const k of ['kcal', 'protein', 'carbs', 'fat', 'fiber', 'sugar']) if (a[k] != null) per100[k] = a[k];
      const servings = a.serving_grams > 0 ? [{ label: a.serving_label || prev.servings?.[0]?.label || 'serving', grams: a.serving_grams }] : prev.servings;
      const next = await store.saveFood({ ...prev, name: a.name || prev.name, brand: a.brand ?? prev.brand, per100, servings });
      return { result: { updated: compactFood(next) }, card: { icon: 'edit', title: `Edited ${next.name}` }, undo: () => store.saveFood(prev) };
    },
  },
  {
    name: 'delete_food', risk: 'destructive',
    description: "Delete one of the user's custom foods from their library (diary entries are kept).",
    parameters: { type: 'object', properties: { food_id: { type: 'string' } }, required: ['food_id'] },
    async preview({ food_id }) { const f = await store.getFood(food_id); return `Delete custom food “${f?.name || food_id}” from your library`; },
    async run({ food_id }) {
      const prev = await store.getFood(food_id);
      if (!prev || prev.source !== 'custom') throw new Error('Only custom foods can be deleted.');
      await store.deleteFood(food_id);
      return { result: { deleted: prev.name }, card: { icon: 'trash', title: `Deleted ${prev.name}` }, undo: () => store.saveFood(prev) };
    },
  },
  {
    name: 'set_targets', risk: 'destructive',
    description: 'Change daily targets. Only pass the values to change.',
    parameters: { type: 'object', properties: { kcal: { type: 'number' }, protein: { type: 'number' }, carbs: { type: 'number' }, fat: { type: 'number' }, fiber: { type: 'number' }, water_ml: { type: 'number' } } },
    preview: a => `Set targets: ${Object.entries(a).filter(([, v]) => v != null).map(([k, v]) => `${k.replace('_ml', '')} ${fmt(v)}`).join(', ')}`,
    async run(a) {
      const prev = { ...store.getSettings().targets };
      const next = { ...prev };
      for (const [k, v] of Object.entries({ kcal: a.kcal, protein: a.protein, carbs: a.carbs, fat: a.fat, fiber: a.fiber, water: a.water_ml })) if (v > 0) next[k] = Math.round(v);
      if (next.kcal < 1000) throw new Error('Calorie target below 1000 kcal is not allowed.');
      await store.saveSettings({ targets: next });
      return { result: { targets: next }, card: { icon: 'target', title: 'Updated targets', detail: `${fmt(next.kcal)} kcal · P${next.protein} C${next.carbs} F${next.fat}` }, undo: () => store.saveSettings({ targets: prev }) };
    },
  },
  {
    name: 'update_profile', risk: 'destructive',
    description: 'Update body stats or goal and (by default) recalculate targets with the Mifflin-St Jeor calculator.',
    parameters: {
      type: 'object',
      properties: {
        sex: { type: 'string', enum: ['male', 'female'] }, age: { type: 'number' }, height_cm: { type: 'number' }, weight_kg: { type: 'number' },
        activity: { type: 'string', enum: Object.keys(ACTIVITY_KEYS) }, goal: { type: 'string', enum: ['lose', 'maintain', 'gain'] },
        rate_kg_per_week: { type: 'number' }, diet: { type: 'string', enum: DIETS.map(d => d.id) },
        recalculate_targets: { type: 'boolean', description: 'Default true' },
      },
    },
    preview: a => `Update profile (${Object.keys(a).filter(k => k !== 'recalculate_targets').join(', ')})${a.recalculate_targets === false ? '' : ' and recalculate targets'}`,
    async run(a) {
      const s = store.getSettings();
      const prev = { profile: { ...s.profile }, targets: { ...s.targets } };
      const p = { ...s.profile };
      if (a.sex) p.sex = a.sex;
      if (a.age > 0) p.age = a.age;
      if (a.height_cm > 0) p.heightCm = a.height_cm;
      if (a.weight_kg > 0) p.weightKg = a.weight_kg;
      if (a.activity) p.activity = ACTIVITY_KEYS[a.activity] ?? p.activity;
      if (a.goal) p.goal = a.goal;
      if (a.rate_kg_per_week > 0) p.rate = Math.min(1, a.rate_kg_per_week);
      if (a.diet) p.diet = a.diet;
      const patch = { profile: p };
      let t;
      if (a.recalculate_targets !== false) {
        t = calcTargets(p);
        patch.targets = { kcal: t.kcal, protein: t.protein, carbs: t.carbs, fat: t.fat, fiber: t.fiber, water: t.water };
      }
      await store.saveSettings(patch);
      return {
        result: { profile: { ...p, activity: activityName(p.activity) }, targets: patch.targets, bmr: t?.bmr, tdee: t?.tdee },
        card: { icon: 'calc', title: 'Updated profile', detail: t ? `New target ${fmt(t.kcal)} kcal` : '' },
        undo: () => store.saveSettings(prev),
      };
    },
  },
  {
    name: 'log_weight', risk: 'write',
    description: 'Record a body-weight weigh-in (kg or lb).',
    parameters: { type: 'object', properties: { kg: { type: 'number' }, lb: { type: 'number' }, date: { type: 'string' } } },
    preview: ({ kg, lb, date }) => `Log weight ${kg ? `${kg} kg` : `${lb} lb`} on ${normDate(date)}`,
    async run({ kg, lb, date }) {
      const w = kg > 0 ? kg : lb > 0 ? lbToKg(lb) : 0;
      if (!(w > 20 && w < 350)) throw new Error('Give a realistic weight in kg or lb.');
      const d = normDate(date);
      const prev = (await store.getWeights()).find(x => x.date === d);
      const rec = await store.logWeight(d, w);
      if (d === todayKey()) await store.saveSettings({ profile: { weightKg: rec.kg } });
      const imp = store.getSettings().units === 'imperial';
      return { result: { logged: rec }, card: { icon: 'weight', title: 'Logged weight', detail: imp ? `${fmt(kgToLb(rec.kg), 1)} lb` : `${rec.kg} kg` }, undo: () => (prev ? store.logWeight(d, prev.kg) : store.deleteWeight(d)) };
    },
  },
  {
    name: 'log_water', risk: 'write',
    description: 'Add (or with a negative number, remove) water in ml.',
    parameters: { type: 'object', properties: { ml: { type: 'number' }, date: { type: 'string' } }, required: ['ml'] },
    preview: ({ ml }) => `${ml >= 0 ? 'Add' : 'Remove'} ${fmt(Math.abs(ml))} ml water`,
    async run({ ml, date }) {
      if (!(Math.abs(ml) <= 5000)) throw new Error('ml out of range');
      const d = normDate(date);
      const day = await store.addWater(d, Math.round(ml));
      return { result: { water_ml: day.water }, card: { icon: 'droplet', title: `${ml >= 0 ? 'Added' : 'Removed'} ${fmt(Math.abs(ml))} ml water`, detail: `${(day.water / 1000).toFixed(2)} L today` }, undo: () => store.addWater(d, -Math.round(ml)) };
    },
  },
];

export const toolByName = new Map(TOOLS.map(t => [t.name, t]));

// OpenAI-format tool schemas.
export const toolSchemas = () => TOOLS.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));

export function needsApproval(tool, policy = 'destructive') {
  if (policy === 'none' || tool.risk === 'read') return false;
  if (policy === 'all') return true;
  return tool.risk === 'destructive';
}
