// Diet-fit grades: every food gets an A–F grade that reflects how well it suits *your* goals.
//
// The score starts at 50 and each factor adds or subtracts points. Every factor is shown to the user,
// so the grade is never a black box. Factors cover:
//   • Protein density against your own protein target (weighted up for high-protein diets and cuts/bulks)
//   • Calorie density (rewarded on a cut, neutral on a bulk) and liquid calories
//   • Fibre, sugar, saturated fat and salt (UK FSA traffic-light thresholds, per 100 g or 100 ml)
//   • Diet style: net carbs for keto, carb share for low-carb, starchy fuel for endurance
//   • Processing level (NOVA), processed meat, alcohol, trans fats, deep frying
//   • Additives, rated by concern tier (see grade-data.js)
// Hard caps stop a good macro profile from hiding a real problem: ultra-processed food can't be an A,
// a high-concern additive or processed meat caps at C, alcohol and trans fats cap at D.

import {
  ADDITIVES, ADDITIVE_ALIASES, UPF_MARKERS, UPF_GROUPS, UPF_COLOUR_TIER, BUILTIN_EXTRA,
  PROCESSED_MEAT, DEEP_FRIED, FREE_SUGAR_FRUIT, ALCOHOL, PLAIN_DAIRY,
} from './grade-data.js';
import { DIETS, GOALS } from './nutrition.js';
import { builtinById } from './fooddb.js';
import { clamp, esc } from './util.js';

export const GRADES = [
  { letter: 'A', min: 75, verdict: 'Excellent fit for your diet' },
  { letter: 'B', min: 60, verdict: 'Good fit for your diet' },
  { letter: 'C', min: 45, verdict: 'OK in moderation' },
  { letter: 'D', min: 32, verdict: 'Poor fit, so keep portions small' },
  { letter: 'E', min: 20, verdict: 'Bad fit, best as an occasional treat' },
  { letter: 'F', min: 0, verdict: 'Avoid where you can' },
];
const ORDER = GRADES.map(g => g.letter);
const gradeFor = score => GRADES.find(g => score >= g.min) || GRADES[GRADES.length - 1];
const capMax = letter => { const i = ORDER.indexOf(letter); return i <= 0 ? 100 : GRADES[i - 1].min - 1; };

export const TIERS = [
  { label: 'No known concern', short: 'Fine' },
  { label: 'Low concern', short: 'Low' },
  { label: 'Moderate concern', short: 'Moderate' },
  { label: 'High concern', short: 'High' },
];
const TIER_PTS = [0, -1, -5, -12];

// Fields that carry grade data; copied when a food is re-fetched or rebuilt from a diary entry.
export const GRADE_FIELDS = ['additives', 'additivesKnown', 'nova', 'nutriscore', 'group1', 'group2', 'ingredients', 'usdaCategory'];

const pct = x => `${Math.round(x * 100)}%`;
const r1 = x => Math.round(x * 10) / 10;

// ---------- Additives ----------
export function normalizeAdditive(raw) {
  const c = String(raw || '').toLowerCase().replace(/^[a-z]{2}:/, '').replace(/[^a-z0-9]/g, '');
  if (!/^e\d{3,4}/.test(c)) return null;
  if (ADDITIVES[c]) return c;
  const base = c.match(/^e\d{3,4}[a-f]?/)?.[0];
  if (base && ADDITIVES[base]) return base;
  const digits = c.match(/^e\d{3,4}/)[0];
  return ADDITIVES[digits] ? digits : digits; // unknown codes are kept and shown as unrated
}

const ALIAS_LIST = Object.entries(ADDITIVE_ALIASES)
  .sort((a, b) => b[0].length - a[0].length)
  .map(([name, code]) => [new RegExp(`(^|[^a-z])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?(?![a-z])`, 'i'), code]);

// Strip "no artificial colours or flavourings"-style claims so they don't read as ingredients.
const stripClaims = text => String(text || '').replace(/\b(?:no|free from|without|contains no)\b[^.;()[\]]*/gi, ' ');

export function additivesFromText(text) {
  const t = stripClaims(text);
  if (!t.trim()) return [];
  const found = new Set();
  for (const m of t.matchAll(/\bE\s?-?(\d{3,4})\s?([a-f])?\b/gi)) {
    const code = normalizeAdditive(`e${m[1]}${m[2] || ''}`);
    if (code) found.add(code);
  }
  for (const [re, code] of ALIAS_LIST) if (re.test(t)) found.add(code);
  // Drop a generic code when a more specific one from the same family was found (e150 vs e150d).
  for (const c of [...found]) if ([...found].some(o => o !== c && o.startsWith(c) && /[a-f]$/.test(o))) found.delete(c);
  return [...found];
}

export function additiveInfo(code) {
  const a = ADDITIVES[code];
  const label = code.toUpperCase().replace(/^E(\d+)([A-F]?)$/, (_, d, s) => `E${d}${s.toLowerCase()}`);
  if (!a) return { code, label, tier: null, name: 'Not in the database', group: 'other', note: 'This additive isn\'t rated yet.' };
  const [tier, name, group, note] = a;
  return { code, label, tier, name, group, note };
}

// Additive codes for a food: Open Food Facts tags first, otherwise parsed from the ingredient list.
function additivesFor(food) {
  if (Array.isArray(food.additives) && (food.additives.length || food.additivesKnown)) {
    return { list: [...new Set(food.additives.map(normalizeAdditive).filter(Boolean))], known: true, from: 'label' };
  }
  if (food.ingredients) return { list: additivesFromText(food.ingredients), known: true, from: 'ingredients' };
  return { list: [], known: false, from: null };
}

// ---------- Processing level (NOVA) ----------
function novaFromIngredients(text, additives) {
  const t = stripClaims(text).toLowerCase();
  if (!t.trim()) return null;
  const infos = additives.map(additiveInfo);
  if (UPF_MARKERS.some(m => t.includes(m))) return 4;
  if (infos.some(a => UPF_GROUPS.has(a.group) || (a.group === 'colour' && (a.tier ?? 1) >= UPF_COLOUR_TIER))) return 4;
  const parts = t.split(/[,;]/).filter(s => s.trim()).length;
  if (parts <= 1) return 1;
  if (additives.length || /\b(salt|sugar|oil|vinegar|syrup|butter|cheese)\b/.test(t)) return 3;
  return 1;
}

// ---------- Context: what kind of food is this? ----------
function context(food) {
  const id = String(food.id || '');
  const key = food.key || (id.startsWith('builtin:') ? id.slice(8) : null);
  const builtin = key ? builtinById.get(`builtin:${key}`) : null;
  const category = food.category || builtin?.category || '';
  const g1 = String(food.group1 || '').toLowerCase();
  const g2 = String(food.group2 || '').toLowerCase();
  const uc = String(food.usdaCategory || '').toLowerCase();
  const name = String(food.name || '').toLowerCase();

  const alcohol = ALCOHOL.has(key) || g1 === 'alcoholic beverages' || /alcoholic/.test(uc);
  const drink = alcohol || category === 'drink' || g1 === 'beverages' || /beverage|juice|drink|milk(?!.*powder)/.test(uc) && !/dry|powder/.test(uc);
  const juice = FREE_SUGAR_FRUIT.has(key) || ['fruit juices', 'fruit nectars'].includes(g2) || (/juice|smoothie/.test(uc + ' ' + name) && drink);
  const intrinsicSugar = !juice && (
    (builtin && ['fruit', 'veg'].includes(category)) || PLAIN_DAIRY.has(key) ||
    ['fruits', 'vegetables', 'dried fruits', 'legumes', 'nuts', 'potatoes'].includes(g2) ||
    (!builtin && !g2 && /fruit|vegetable|legume|nut and seed/.test(uc))
  );
  const plainMilkish = g2 === 'milk and yogurt' || PLAIN_DAIRY.has(key) || /dairy and egg/.test(uc);
  const meatName = /\b(bacon|ham|salami|pepperoni|chorizo|sausages?|hot ?dogs?|frankfurters?|prosciutto|pastrami|corned beef|luncheon meat|spam|kabanos|biltong|jerky)\b/.test(name);
  const processedMeat = PROCESSED_MEAT.has(key) || g2 === 'processed meat' || (!builtin && !g2 && meatName);
  const oilyFish = ['salmon', 'sashimi', 'poke'].includes(key) || (!builtin && /\b(salmon|mackerel|sardines?|herring|trout|anchov(y|ies)|kippers?|pilchards?)\b/.test(name) && !/flavou?r/.test(name));
  return { key, builtin, category, drink, juice, alcohol, intrinsicSugar, plainMilkish, processedMeat, oilyFish, deepFried: DEEP_FRIED.has(key) };
}

// ---------- The grader ----------
/**
 * Grade a food for the current user. Returns null when there's nothing to grade (quick adds, no calories).
 * The grade describes the food itself (per 100 g), not the portion.
 */
export function gradeFood(food, settings) {
  if (!food || food.source === 'quick') return null;
  const per = food.per100 || {};
  if (!(per.kcal >= 0) || per.kcal == null) return null;

  const tg = settings?.targets || {};
  const profile = settings?.profile || {};
  const goal = profile.goal || 'maintain';
  const diet = profile.diet || 'balanced';
  const ctx = context(food);
  const extra = ctx.key ? BUILTIN_EXTRA[ctx.key] : null;

  // Nutrition, filling gaps for built-in foods with typical values.
  const n = { ...per };
  const estimated = [];
  for (const k of ['sugar', 'satFat', 'sodium']) {
    if (n[k] == null && extra && extra[k] != null) { n[k] = extra[k]; estimated.push(k); }
  }
  const kcal = +n.kcal || 0;
  const protein = +n.protein || 0, carbs = +n.carbs || 0, fat = +n.fat || 0;
  const unit = ctx.drink ? 'ml' : 'g';

  const factors = [];
  const caps = [];
  const add = (pts, title, detail, extraProps = {}) => factors.push({ pts: Math.round(pts), title, detail, ...extraProps });
  const cap = (letter, reason) => caps.push({ letter, reason });

  // 1. Protein density vs your target.
  const target = clamp(((+tg.protein || 0) * 4) / (+tg.kcal || 2000), 0.12, 0.45) || 0.25;
  const share = kcal > 0 ? (protein * 4) / kcal : 0;
  const ratio = share / target;
  if (kcal >= 40 || (ctx.drink && kcal >= 20)) {
    const w = (diet === 'highprotein' ? 1.25 : 1) * (goal !== 'maintain' ? 1.15 : 1);
    const why = `${pct(share)} of its calories come from protein; your target is ${pct(target)}.`;
    // Continuous, so a food just under your target ratio isn't marked down a whole band.
    const pts = clamp((ratio - 0.4) / 1.2, 0, 1) * 16 * w;
    if (ratio >= 1.4) add(pts, 'Excellent protein for its calories', why);
    else if (ratio >= 0.95) add(pts, 'Protein-dense', why);
    else if (ratio >= 0.65) add(pts, 'Decent protein', why);
    else if (ratio < 0.4) add(kcal >= 150 ? -6 * w : -2, kcal >= 150 ? 'Little protein for the calories' : 'Low in protein', why);
  }

  // 2. Calorie density (solid food) and liquid calories.
  if (!ctx.drink) {
    const why = `${Math.round(kcal)} kcal per 100 g.`;
    if (goal === 'gain') {
      if (kcal >= 250 && ratio >= 0.7) add(4, 'Calorie-dense with good protein', `${why} Handy for hitting a surplus.`);
    } else {
      const m = goal === 'lose' ? 1 : 0.5;
      const tail = goal === 'lose' ? ' Low-density foods make a deficit easier to stick to.' : '';
      if (kcal < 60) add(10 * m, 'Very filling for few calories', why + tail);
      else if (kcal < 120) add(6 * m, 'Low calorie density', why + tail);
      else if (kcal < 200) add(2 * m, 'Moderate calorie density', why + tail);
      else if (kcal > 450) add(-10 * m, 'Very calorie-dense', `${why} Easy to overeat, so weigh portions.`);
      else if (kcal > 300) add(-6 * m, 'Calorie-dense', `${why} Portions add up fast.`);
    }
  } else if (!ctx.alcohol && kcal < 5) {
    add(10, 'Virtually calorie-free', `${r1(kcal)} kcal per 100 ml.`);
  } else if (!ctx.alcohol && kcal > 15 && share < 0.2) {
    add(goal === 'lose' ? -10 : goal === 'gain' ? -3 : -6, 'Liquid calories', `${Math.round(kcal)} kcal per 100 ml. Calories in drinks don't fill you up, so they're easy to overdo.`);
  }

  // 3. Fibre.
  if (n.fiber != null && kcal >= 20) {
    const fpk = (n.fiber / kcal) * 100;
    const why = `${r1(n.fiber)} g per 100 g (${r1(fpk)} g per 100 kcal).`;
    if (fpk >= 3) add(10, 'Rich in fibre', why);
    else if (fpk >= 1.5) add(6, 'Good source of fibre', why);
    else if (fpk >= 0.8) add(2, 'Some fibre', why);
  }

  // 4–6. Sugar, saturated fat, salt (UK FSA front-of-pack thresholds).
  const est = k => estimated.includes(k) ? ' Typical value for this food.' : '';
  const lights = { sugar: null, satFat: null, salt: null };
  if (n.sugar != null) {
    const s = +n.sugar;
    const hi = ctx.drink ? 11.25 : 22.5, med = ctx.drink ? 2.5 : 5;
    lights.sugar = ctx.intrinsicSugar ? 'green' : s > hi ? 'red' : s > med ? 'amber' : 'green';
    if (ctx.intrinsicSugar) {
      if (s > med) add(0, 'Natural sugars', `${r1(s)} g per 100 ${unit}, naturally present in fruit, veg or plain dairy, so it isn't counted as free sugar.`);
    } else {
      const w = (diet === 'keto' || diet === 'lowcarb' ? 1.4 : 1) * (goal === 'lose' ? 1.1 : 1);
      const title = ctx.juice ? 'Fruit juice sugar' : null;
      const tail = ctx.juice ? ' Juiced or blended fruit counts as free sugar.' : '';
      if (s > hi) add(-12 * w, title || 'High in sugar', `${r1(s)} g per 100 ${unit}: red on UK traffic lights.${tail}${est('sugar')}`);
      else if (s > med) add(-4 * w, title || 'Medium sugar', `${r1(s)} g per 100 ${unit}: amber on UK traffic lights.${tail}${est('sugar')}`);
      if (kcal > 0 && (s * 4) / kcal > 0.5 && s > 10) add(-6 * w, 'Mostly sugar', `${pct(Math.min(1, (s * 4) / kcal))} of the calories are sugar.`);
    }
  }
  if (n.satFat != null) {
    const v = +n.satFat;
    const hi = ctx.drink ? 2.5 : 5, med = ctx.drink ? 0.75 : 1.5;
    const w = diet === 'keto' ? 0.6 : 1;
    lights.satFat = v > hi ? 'red' : v > med ? 'amber' : 'green';
    if (v > hi) add(-8 * w, 'High in saturated fat', `${r1(v)} g per 100 ${unit}: red on UK traffic lights.${est('satFat')}`);
    else if (v > med) add(-3 * w, 'Medium saturated fat', `${r1(v)} g per 100 ${unit}: amber on UK traffic lights.${est('satFat')}`);
  }
  if (n.sodium != null) {
    const salt = (+n.sodium * 2.5) / 1000;
    const hi = ctx.drink ? 0.75 : 1.5, med = 0.3;
    lights.salt = salt > hi ? 'red' : salt > med ? 'amber' : 'green';
    if (salt > hi) add(-10, 'High in salt', `${salt.toFixed(2)} g salt per 100 ${unit}: red on UK traffic lights.${est('sodium')}`);
    else if (salt > med) add(-3, 'Medium salt', `${salt.toFixed(2)} g salt per 100 ${unit}: amber on UK traffic lights.${est('sodium')}`);
  }
  if (lights.sugar === 'green' && lights.satFat === 'green' && lights.salt === 'green') {
    add(4, 'Low in sugar, saturated fat and salt', 'Green on all three UK traffic lights.');
  }

  // 7. Diet style.
  if (diet === 'keto') {
    const net = Math.max(0, carbs - (+n.fiber || 0));
    const why = `${r1(net)} g net carbs per 100 ${unit}; your keto target is about ${Math.round(+tg.carbs || 25)} g a day.`;
    if (kcal < 40) { if (net <= 5) add(3, 'Keto-friendly', why); else add(-4, 'Watch the carbs', why); }
    else if (net <= 3) add(8, 'Keto-friendly', why);
    else if (net <= 6) add(2, 'Low net carbs', why);
    else if (net <= 12) add(-8, 'Carb-heavy for keto', why);
    else add(-18, 'Too many carbs for keto', why);
  } else if (diet === 'lowcarb' && kcal >= 40) {
    const cs = (carbs * 4) / kcal;
    const why = `${pct(cs)} of its calories come from carbs; your plan aims for about 20%.`;
    if (cs < 0.15) add(5, 'Low carb', why);
    else if (cs > 0.6) add(-8, 'Carb-heavy for low-carb', why);
    else if (cs > 0.45) add(-4, 'Fairly carb-heavy', why);
  } else if (diet === 'endurance' && kcal >= 60) {
    const cs = (carbs * 4) / kcal;
    const sugarShare = n.sugar != null ? (n.sugar * 4) / kcal : 0;
    if (cs > 0.5 && sugarShare < 0.25) add(4, 'Good carb fuel', `${pct(cs)} of calories from mostly starchy carbs, which top up glycogen for endurance training.`);
  }

  // 8. Processing level.
  const adds = additivesFor(food);
  let nova = null, novaSource = null;
  if ([1, 2, 3, 4].includes(+food.nova)) { nova = +food.nova; novaSource = 'label'; }
  else if (food.ingredients) { nova = novaFromIngredients(food.ingredients, adds.list); novaSource = nova ? 'ingredients' : null; }
  else if (extra?.nova) { nova = extra.nova; novaSource = 'typical'; }
  const novaNote = novaSource === 'typical' ? ' Typical for this kind of food; a scanned product may differ.' : novaSource === 'ingredients' ? ' Estimated from the ingredients.' : '';
  if (nova === 1) add(8, 'Whole or minimally processed', `NOVA group 1.${novaNote}`);
  else if (nova === 2) add(0, 'Culinary ingredient', `NOVA group 2: oils, butter, sugar, salt and similar.${novaNote}`);
  else if (nova === 3) add(0, 'Processed', `NOVA group 3: made with salt, sugar or oil, like cheese, bread or tinned fish.${novaNote}`);
  else if (nova === 4) {
    add(-14, 'Ultra-processed', `NOVA group 4: an industrial formulation. Diets high in these foods are linked to overeating and poorer health.${novaNote}`);
    cap('B', 'Ultra-processed foods can\'t score an A');
  } else add(0, 'Processing level unknown', 'There isn\'t enough information to tell how processed this is.');

  // 9. Additives.
  const additives = adds.list.map(additiveInfo).sort((a, b) => (b.tier ?? -1) - (a.tier ?? -1) || a.label.localeCompare(b.label));
  const concern = additives.filter(a => a.tier >= 2);
  const high = additives.filter(a => a.tier === 3);
  if (adds.known) {
    if (!additives.length) {
      add(3, 'No additives', adds.from === 'label' ? 'No additives listed on the product.' : 'None found in the ingredients.');
    } else {
      // The worst additive counts in full, each further one at half weight (they overlap with the
      // ultra-processing penalty), capped so additives alone can't sink a food to F.
      const pts = Math.max(-24, additives.reduce((s, a, i) => s + (TIER_PTS[a.tier] || 0) * (i === 0 ? 1 : 0.5), 0));
      if (concern.length) {
        add(pts, `${concern.length} additive${concern.length > 1 ? 's' : ''} of concern`, concern.map(a => `${a.label} ${a.name}`).join(', ') + '.', { additives: true });
      } else if (pts < 0) {
        add(pts, 'Only low-concern additives', `${additives.length} additive${additives.length > 1 ? 's' : ''}, none of them a significant worry.`, { additives: true });
      } else {
        add(0, 'Harmless additives only', `${additives.length} additive${additives.length > 1 ? 's' : ''} with no known concern.`, { additives: true });
      }
      if (additives.length >= 8) add(-4, 'Long additive list', `${additives.length} additives in total.`);
      if (high.length >= 2) cap('D', 'Contains several high-concern additives');
      else if (high.length === 1) cap('C', `Contains ${high[0].label} (${high[0].name})`);
    }
  } else {
    const msg = ctx.builtin
      ? nova === 1 ? 'Whole food, so no additives are expected.' : 'This is a generic food with no product label. Scan a barcode to check a specific product.'
      : food.source === 'off' && food.additives === undefined ? 'This product was saved before additive checking. Refresh it to load the label.'
      : food.source === 'off' ? 'Open Food Facts doesn\'t have this product\'s ingredients yet.'
      : food.source === 'custom' ? 'Paste the ingredients list into this food to check its additives.'
      : 'No ingredient list available for this food.';
    add(0, nova === 1 && ctx.builtin ? 'No additives expected' : 'Additives not checked', msg);
  }

  // 10. Specific health flags.
  const hasNitrite = additives.some(a => ['e249', 'e250', 'e251', 'e252'].includes(a.code));
  if (ctx.processedMeat) {
    add(hasNitrite ? -4 : -8, 'Processed meat', 'WHO/IARC classes processed meat as a cause of bowel cancer, so keep it occasional.');
    cap('C', 'Processed meat');
  }
  if (ctx.alcohol) {
    add(-15, 'Alcohol', 'Alcohol has 7 kcal per gram and no nutrients, and it slows fat loss and muscle recovery.');
    cap('D', 'Alcoholic drink');
  }
  const ing = stripClaims(food.ingredients || '').toLowerCase();
  if (/partially hydrogenated|partially-hydrogenated/.test(ing)) {
    add(-12, 'Trans fat (partially hydrogenated oil)', 'Artificial trans fats raise heart disease risk more than any other fat.');
    cap('D', 'Contains trans fat');
  } else if (/\bhydrogenated\b/.test(ing)) {
    add(-4, 'Hydrogenated fat', 'Hardened industrial fat, a sign of heavy processing.');
  }
  if (ctx.oilyFish) add(6, 'Oily fish', 'Rich in omega-3 fats (EPA and DHA), which support heart health and recovery.');
  if (ctx.deepFried) add(-3, 'Usually deep-fried', 'Frying adds fat and calories, and repeatedly heated oil forms harmful compounds.');

  // 11. Reference only.
  if (/^[a-e]$/i.test(food.nutriscore || '')) {
    add(0, `Nutri-Score ${food.nutriscore.toUpperCase()}`, 'Open Food Facts\' general health score, shown for reference. Your grade is personalised to your own goals.', { ref: true });
  }

  // Score, caps, grade.
  let score = clamp(Math.round(50 + factors.reduce((s, f) => s + f.pts, 0)), 0, 100);
  const tightest = caps.reduce((m, c) => (capMax(c.letter) < capMax(m?.letter) ? c : m), null);
  let capped = null;
  if (tightest && score > capMax(tightest.letter)) { score = capMax(tightest.letter); capped = tightest; }
  const g = gradeFor(score);

  // Data notes.
  const notes = [];
  const missing = ['sugar', 'satFat', 'sodium', 'fiber'].filter(k => n[k] == null);
  const names = { sugar: 'sugar', satFat: 'saturated fat', sodium: 'salt', fiber: 'fibre' };
  if (estimated.length) notes.push(`Uses typical values for ${estimated.map(k => names[k]).join(', ')}.`);
  if (missing.length) notes.push(`No data for ${missing.map(k => names[k]).join(', ')}, so ${missing.length > 1 ? 'they weren\'t' : 'it wasn\'t'} scored.`);

  return {
    score,
    letter: g.letter,
    verdict: g.verdict,
    factors: factors.sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts)),
    additives,
    additivesKnown: adds.known,
    additivesFrom: adds.from,
    caps,
    capped,
    nova,
    novaSource,
    notes,
    plan: planLabel(goal, diet),
  };
}

export function planLabel(goal, diet) {
  const gl = GOALS.find(x => x.id === goal)?.label || 'Maintain';
  const dl = DIETS.find(x => x.id === diet)?.label || 'Balanced';
  return `${gl} · ${dl}`;
}

// Calorie-weighted average grade for a set of entries, e.g. a day's diary.
export function averageGrade(items) {
  const valid = items.filter(i => i.grade && i.kcal > 0);
  const total = valid.reduce((s, i) => s + i.kcal, 0);
  if (!total) return null;
  const score = Math.round(valid.reduce((s, i) => s + i.grade.score * i.kcal, 0) / total);
  return { score, ...gradeFor(score) };
}

// Combine a food snapshot (e.g. a diary entry) with the full stored or built-in food, so additives,
// NOVA and category are available for grading.
export function withGradeData(food, stored) {
  if (!food) return food;
  const id = String(food.id || '');
  const b = id.startsWith('builtin:') ? builtinById.get(id) : null;
  let out = food;
  if (b) out = { ...b, ...food, key: b.key, category: b.category };
  if (stored) for (const k of GRADE_FIELDS) if (out[k] == null && stored[k] != null) out = { ...out, [k]: stored[k] };
  return out;
}

// ---------- Small UI helpers ----------
export function gradeBadge(g, size = '') {
  if (!g) return '';
  return `<span class="grade grade-${g.letter.toLowerCase()} ${size}" title="Diet fit ${g.letter}: ${esc(g.verdict)}" aria-label="Diet fit grade ${g.letter}">${g.letter}</span>`;
}

export const tierDot = tier => `<span class="tier-dot tier-${tier ?? 'x'}" aria-hidden="true"></span>`;
