// Online food databases: Open Food Facts (barcodes, branded products) and USDA FoodData Central
// (generic foods + branded UPC fallback). All results are normalised to the app's food shape.

import { getSettings, getFoodByBarcode, saveFood, getFood } from './store.js';
import { kcalFromMacros } from './nutrition.js';

const OFF = 'https://world.openfoodfacts.org';
const USDA = 'https://api.nal.usda.gov/fdc/v1';
const OFF_FIELDS = 'code,product_name,product_name_en,generic_name,brands,quantity,serving_size,serving_quantity,nutriments,image_front_small_url,image_front_thumb_url,image_small_url,' +
  'additives_tags,additives_n,nova_group,nutriscore_grade,pnns_groups_1,pnns_groups_2,ingredients_text_en,ingredients_text'; // grade data

const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : undefined; };
const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && Number.isFinite(v)).map(([k, v]) => [k, Math.round(v * 100) / 100]));

export const normalizeCode = code => String(code || '').replace(/\D/g, '');

function codeVariants(code) {
  const c = normalizeCode(code);
  const set = new Set([c]);
  if (c.length === 13 && c.startsWith('0')) set.add(c.slice(1)); // EAN-13 → UPC-A
  if (c.length === 12) set.add('0' + c); // UPC-A → EAN-13
  return [...set];
}

function prettyName(s) {
  s = String(s || '').trim();
  const letters = s.replace(/[^a-z]/gi, '');
  if (letters && letters === letters.toUpperCase()) s = s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  return s;
}

function servingLabel(text) {
  const t = String(text || '').replace(/\(?\s*\d+([.,]\d+)?\s*(grams?|gr|g|millilit(er|re)s?|ml)\b\.?\s*\)?/gi, '').trim();
  return t && t.length < 40 ? t : 'serving';
}

// ---------- Open Food Facts ----------
export function fromOFF(p) {
  const n = p.nutriments || {};
  let kcal = num(n['energy-kcal_100g']);
  if (kcal == null && num(n['energy-kj_100g']) != null) kcal = num(n['energy-kj_100g']) / 4.184;
  if (kcal == null && num(n.energy_100g) != null) kcal = num(n.energy_100g) / 4.184; // energy_100g is kJ
  const per100 = {
    kcal,
    protein: num(n.proteins_100g),
    carbs: num(n.carbohydrates_100g),
    fat: num(n.fat_100g),
    fiber: num(n.fiber_100g),
    sugar: num(n.sugars_100g),
    satFat: num(n['saturated-fat_100g']),
    sodium: n.sodium_100g != null ? num(n.sodium_100g) * 1000 : n.salt_100g != null ? num(n.salt_100g) * 400 : undefined,
  };
  const sq = num(p.serving_quantity);
  // Some products only carry per-serving values.
  if (per100.kcal == null && sq > 0 && num(n['energy-kcal_serving']) != null) {
    const f = 100 / sq;
    per100.kcal = num(n['energy-kcal_serving']) * f;
    per100.protein ??= num(n.proteins_serving) * f;
    per100.carbs ??= num(n.carbohydrates_serving) * f;
    per100.fat ??= num(n.fat_serving) * f;
  }
  if (per100.kcal == null && per100.protein == null && per100.carbs == null) return null;
  if (per100.kcal == null) per100.kcal = kcalFromMacros(per100.protein || 0, per100.carbs || 0, per100.fat || 0);

  const brand = (Array.isArray(p.brands) ? p.brands[0] : String(p.brands || '').split(',')[0]) || '';
  const ingredients = String(p.ingredients_text_en || p.ingredients_text || '').replace(/\s+/g, ' ').trim().slice(0, 1500);
  const nova = parseInt(p.nova_group, 10);
  const group = g => (g && g !== 'unknown' ? String(g) : undefined);
  return {
    id: `off:${p.code}`,
    source: 'off',
    barcode: p.code ? normalizeCode(p.code) : undefined,
    name: prettyName(p.product_name || p.product_name_en || p.generic_name) || 'Unnamed product',
    brand: brand.trim(),
    image: p.image_front_small_url || p.image_front_thumb_url || p.image_small_url || '',
    quantity: p.quantity || '',
    per100: clean(per100),
    servings: sq > 0 ? [{ label: servingLabel(p.serving_size), grams: Math.round(sq * 10) / 10 }] : [],
    // Grade data. additivesKnown tells "no additives" apart from "ingredients not analysed yet".
    additives: (p.additives_tags || []).map(t => String(t).replace(/^[a-z]{2}:/, '').toLowerCase()),
    additivesKnown: p.additives_n != null || !!ingredients,
    nova: nova >= 1 && nova <= 4 ? nova : undefined,
    nutriscore: /^[a-e]$/.test(p.nutriscore_grade || '') ? p.nutriscore_grade : undefined,
    group1: group(p.pnns_groups_1),
    group2: group(p.pnns_groups_2),
    ingredients: ingredients || undefined,
  };
}

async function lookupOFF(code, signal) {
  const url = `${OFF}/api/v2/product/${code}.json?fields=${OFF_FIELDS}`;
  let r;
  try { r = await fetch(url, { signal }); } catch (e) {
    if (e.name === 'AbortError') throw e;
    await new Promise(res => setTimeout(res, 500)); // one retry for transient 5xx/CORS blips
    r = await fetch(url, { signal });
  }
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Open Food Facts error ${r.status}`);
  const j = await r.json();
  if (j.status !== 1 || !j.product) return null;
  return fromOFF({ ...j.product, code: j.product.code || code });
}

// OFF country server for the user's locale (en-GB → uk, de-DE → de), used as a fallback mirror.
function offCountry() {
  const region = (navigator.language || '').split('-')[1]?.toLowerCase();
  if (!region) return null;
  return region === 'gb' ? 'uk' : region;
}

// OFF's full-text search sheds load with intermittent 503s (which surface as CORS failures in the
// browser), so retry with backoff and fall back to the user's country server.
export async function searchOFF(q, signal) {
  const hosts = ['world', 'world', offCountry()].filter(Boolean);
  for (let i = 0; i < hosts.length; i++) {
    try {
      const r = await fetch(`https://${hosts[i]}.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=24&fields=${OFF_FIELDS}`, { signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return ((await r.json()).products || []).map(fromOFF).filter(Boolean);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      if (i < hosts.length - 1) await new Promise(res => setTimeout(res, 350 * (i + 1)));
    }
  }
  throw new Error('Open Food Facts search is busy — try again in a moment');
}

// ---------- USDA FoodData Central ----------
const usdaKey = () => getSettings().usdaKey?.trim() || 'DEMO_KEY';
const NID = {
  kcal: [1008, 2047, 2048],
  protein: [1003],
  carbs: [1005, 1050],
  fat: [1004, 1085],
  fiber: [1079],
  sugar: [2000, 1063],
  satFat: [1258],
  sodium: [1093],
};

export function fromUSDA(f) {
  const byId = new Map((f.foodNutrients || []).map(n => [n.nutrientId, n]));
  const pick = ids => {
    for (const id of ids) {
      const n = byId.get(id);
      if (n && n.value != null) return String(n.unitName).toUpperCase() === 'KJ' ? n.value / 4.184 : n.value;
    }
  };
  const per100 = Object.fromEntries(Object.entries(NID).map(([k, ids]) => [k, pick(ids)]));
  if (per100.kcal == null && per100.protein == null) return null;
  if (per100.kcal == null) per100.kcal = kcalFromMacros(per100.protein || 0, per100.carbs || 0, per100.fat || 0);
  const unit = String(f.servingSizeUnit || '').toLowerCase();
  const servings = f.servingSize && /^(g|grm|ml|mlt)$/.test(unit)
    ? [{ label: servingLabel(f.householdServingFullText), grams: Math.round(f.servingSize * 10) / 10 }]
    : [];
  return {
    id: `usda:${f.fdcId}`,
    source: 'usda',
    barcode: f.gtinUpc ? normalizeCode(f.gtinUpc) : undefined,
    name: prettyName(f.description),
    brand: prettyName(f.brandName || f.brandOwner || ''),
    usdaType: f.dataType,
    usdaCategory: f.foodCategory || undefined,
    ingredients: f.ingredients ? String(f.ingredients).slice(0, 1500) : undefined,
    per100: clean(per100),
    servings,
  };
}

async function usdaFetch(params, signal) {
  const r = await fetch(`${USDA}/foods/search?api_key=${encodeURIComponent(usdaKey())}&${params}`, { signal });
  if (r.status === 429 || r.status === 403) throw new Error('USDA rate limit reached — add your free API key in Profile → Food databases');
  if (!r.ok) throw new Error(`USDA error ${r.status}`);
  return (await r.json()).foods || [];
}

async function lookupUSDA(code, signal) {
  const variants = codeVariants(code);
  const strip = c => normalizeCode(c).replace(/^0+/, '');
  const query = variants.find(v => v.length === 12) || variants[0];
  const foods = await usdaFetch(`query=${query}&dataType=Branded&pageSize=10`, signal);
  const hit = foods.find(f => f.gtinUpc && strip(f.gtinUpc) === strip(code));
  return hit ? fromUSDA(hit) : null;
}

// Generic (non-branded) foods: Foundation, SR Legacy and FNDDS survey dishes. Branded items come from OFF.
// USDA's API now rejects "Survey (FNDDS)" as a dataType filter (400) while still returning those foods
// unfiltered, so search without a filter and drop branded items here.
export async function searchUSDA(q, signal) {
  const foods = await usdaFetch(`query=${encodeURIComponent(q)}&pageSize=50`, signal);
  return foods.filter(f => f.dataType !== 'Branded').slice(0, 25).map(fromUSDA).filter(Boolean);
}

// Re-fetch a saved Open Food Facts product to pick up fields added after it was first saved
// (additives, NOVA, ingredients). Keeps the user's own data: favourite, usage, custom servings.
export async function refreshFood(food, signal) {
  if (food?.source !== 'off' || !food.barcode) return null;
  const fresh = await lookupOFF(food.barcode, signal);
  if (!fresh) return null;
  const stored = (await getFood(food.id)) || food;
  return saveFood({ ...stored, ...fresh, id: stored.id, servings: stored.servings?.length ? stored.servings : fresh.servings });
}

// ---------- Barcode lookup chain: local cache → OFF → USDA ----------
export async function lookupBarcode(code, { signal, onStatus } = {}) {
  const variants = codeVariants(code);
  for (const v of variants) {
    const local = await getFoodByBarcode(v);
    if (local) return { food: local, from: local.source === 'custom' ? 'Your foods' : 'Saved' };
  }
  const errors = [];
  onStatus?.('off');
  try {
    const f = await lookupOFF(variants[0], signal);
    if (f) return { food: await saveFood(f), from: 'Open Food Facts' };
  } catch (e) { if (e.name === 'AbortError') throw e; errors.push(e); }
  onStatus?.('usda');
  try {
    const f = await lookupUSDA(variants[0], signal);
    if (f) return { food: await saveFood({ ...f, barcode: normalizeCode(code) }), from: 'USDA' };
  } catch (e) { if (e.name === 'AbortError') throw e; errors.push(e); }
  if (errors.length === 2) {
    throw new Error(navigator.onLine ? errors.map(e => e.message).join(' · ') : 'You are offline — connect to look up new barcodes');
  }
  return null;
}
