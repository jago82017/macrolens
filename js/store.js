// Domain layer on top of IndexedDB: settings, diary entries, foods, days, weights.
// Every mutation emits an event so views can re-render.

import * as db from './db.js';
import { uid, flags, todayKey } from './util.js';

// ---- Event bus ----
const listeners = new Map();
export function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
  return () => listeners.get(evt)?.delete(fn);
}
export function emit(evt, data) {
  listeners.get(evt)?.forEach(fn => { try { fn(data); } catch (e) { console.error(e); } });
  if (evt !== '*') listeners.get('*')?.forEach(fn => fn(evt, data));
}

// ---- Settings ----
export const DEFAULT_SETTINGS = {
  name: '',
  profile: { sex: 'male', age: 30, heightCm: 175, weightKg: 75, activity: 1.55, goal: 'maintain', rate: 0.5, diet: 'balanced' },
  targets: { kcal: 2300, protein: 150, carbs: 250, fat: 75, fiber: 32, water: 2600 },
  units: 'metric',
  theme: 'system',
  usdaKey: '',
  celebrations: true,
  haptics: true,
  grades: true, // show A–F diet-fit badges in food lists and the diary
  onboarded: false,
  ai: {
    engine: 'auto', // Snap AI: 'auto' (cloud when set up and online), 'cloud' or 'local'
    endpoint: '', // CORS proxy in front of NVIDIA's API (browsers can't call it directly)
    apiKey: '', // optional when the proxy holds the key
    visionModel: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
    agentModel: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', // fastest that reliably answers on the free tier
    effort: 'balanced', // fast | balanced | deep
    accuracy: 'standard', // standard | high (two independent vision passes)
    approval: 'destructive', // destructive | all | none
    corrections: [], // what the user changed after cloud photo estimates, fed back into prompts
  },
};

let settings = structuredClone(DEFAULT_SETTINGS);

function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object'
      ? merge(base[k], v)
      : v;
  }
  return out;
}

export async function loadSettings() {
  const rec = await db.get('settings', 'app');
  settings = merge(structuredClone(DEFAULT_SETTINGS), rec?.value);
  flags.haptics = settings.haptics;
  return settings;
}

export const getSettings = () => settings;

export async function saveSettings(patch) {
  settings = merge(settings, patch);
  await db.put('settings', { key: 'app', value: settings });
  flags.haptics = settings.haptics;
  emit('settings', settings);
  return settings;
}

// ---- Diary entries ----
export async function addEntry(data) {
  const entry = { id: uid(), createdAt: Date.now(), ...data };
  await db.put('entries', entry);
  emit('entries', { action: 'add', date: entry.date, entry });
  return entry;
}

export async function addEntries(list) {
  const entries = list.map((e, i) => ({ id: uid(), createdAt: Date.now() + i, ...e }));
  await db.bulkPut('entries', entries);
  emit('entries', { action: 'add', date: entries[0]?.date, entries });
  return entries;
}

export async function updateEntry(entry) {
  await db.put('entries', entry);
  emit('entries', { action: 'update', date: entry.date, entry });
  return entry;
}

export async function deleteEntry(id) {
  const entry = await db.get('entries', id);
  await db.del('entries', id);
  emit('entries', { action: 'delete', date: entry?.date, entry });
  return entry;
}

export async function getEntries(date) {
  const list = await db.byIndex('entries', 'date', date);
  return list.sort((a, b) => a.createdAt - b.createdAt);
}

export const getEntry = id => db.get('entries', id);

export function getEntriesRange(from, to) {
  return db.byIndex('entries', 'date', IDBKeyRange.bound(from, to));
}

// ---- Foods (custom foods + cached barcode/online lookups + used built-ins) ----
export async function saveFood(food) {
  const f = { createdAt: Date.now(), ...food, updatedAt: Date.now() };
  if (!f.barcode) delete f.barcode; // keep the barcode index clean
  await db.put('foods', f);
  emit('foods', f);
  return f;
}

export const getFood = id => db.get('foods', id);
export const allFoods = () => db.all('foods');

export async function getFoodByBarcode(code) {
  const hits = await db.byIndex('foods', 'barcode', code);
  return hits.sort((a, b) => (b.source === 'custom') - (a.source === 'custom'))[0] || null;
}

export async function deleteFood(id) {
  await db.del('foods', id);
  emit('foods', { id, deleted: true });
}

// Grade-data fields from a fresher copy of a food (e.g. a new search result) fill gaps in the stored one.
const GRADE_FIELDS = ['additives', 'additivesKnown', 'nova', 'nutriscore', 'group1', 'group2', 'ingredients', 'usdaCategory'];
function refreshFields(stored, food) {
  for (const k of GRADE_FIELDS) if (stored[k] == null && food[k] != null) stored[k] = food[k];
  return stored;
}

export async function touchFood(food) {
  const prev = await db.get('foods', food.id);
  const stored = prev ? refreshFields(prev, food) : { ...food, createdAt: Date.now() };
  stored.lastUsed = Date.now();
  stored.uses = (stored.uses || 0) + 1;
  if (!stored.barcode) delete stored.barcode;
  await db.put('foods', stored);
  return stored;
}

export async function toggleFavorite(food) {
  const prev = await db.get('foods', food.id);
  const stored = prev ? refreshFields(prev, food) : { ...food, createdAt: Date.now() };
  stored.favorite = !stored.favorite;
  if (!stored.barcode) delete stored.barcode;
  await db.put('foods', stored);
  emit('foods', stored);
  return stored.favorite;
}

export async function recentFoods(limit = 15) {
  const foods = await db.all('foods');
  return foods.filter(f => f.lastUsed).sort((a, b) => b.lastUsed - a.lastUsed).slice(0, limit);
}

// ---- Saved meals (reusable groups of diary entries) ----
const ENTRY_ONLY = ['id', 'createdAt', 'date', 'meal', 'via'];
export const mealItemFrom = entry => Object.fromEntries(Object.entries(entry).filter(([k]) => !ENTRY_ONLY.includes(k)));

export async function saveMeal(meal) {
  const m = { id: uid(), createdAt: Date.now(), uses: 0, ...meal, updatedAt: Date.now() };
  m.kcal = Math.round(m.items.reduce((s, it) => s + (+it.kcal || 0), 0));
  await db.put('meals', m);
  emit('meals', m);
  return m;
}

export const allMeals = async () => (await db.all('meals')).sort((a, b) => (b.lastUsed || b.createdAt) - (a.lastUsed || a.createdAt));
export const getMeal = id => db.get('meals', id);

export async function deleteMeal(id) {
  await db.del('meals', id);
  emit('meals', { id, deleted: true });
}

// Log every item of a saved meal, optionally scaled (factor 0.5 = half portions).
export async function logMeal(meal, { date, meal: mealId, factor = 1 }) {
  const NUM = ['kcal', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'satFat', 'sodium'];
  const items = meal.items.map(it => {
    const e = { ...it, date, meal: mealId };
    if (factor !== 1) {
      for (const k of NUM) if (e[k] != null) e[k] = Math.round(e[k] * factor * 10) / 10;
      if (e.grams) e.grams = Math.round(e.grams * factor * 10) / 10;
      if (e.qty) e.qty = Math.round(e.qty * factor * 100) / 100;
    }
    return e;
  });
  const added = await addEntries(items);
  await db.put('meals', { ...meal, uses: (meal.uses || 0) + 1, lastUsed: Date.now() });
  return added;
}

// ---- Days (water, celebration flags) ----
export async function getDay(date) {
  return (await db.get('days', date)) || { date, water: 0, celebrated: {} };
}

export async function saveDay(day) {
  await db.put('days', day);
  emit('day', day);
  return day;
}

export async function addWater(date, ml) {
  const day = await getDay(date);
  day.water = Math.max(0, (day.water || 0) + ml);
  return saveDay(day);
}

export const getDaysRange = (from, to) => db.all('days').then(d => d.filter(x => x.date >= from && x.date <= to));

// ---- Body weight ----
export async function logWeight(date, kg) {
  const rec = { date, kg: Math.round(kg * 10) / 10, at: Date.now() };
  await db.put('weights', rec);
  emit('weights', rec);
  return rec;
}
export async function deleteWeight(date) {
  await db.del('weights', date);
  emit('weights', { date, deleted: true });
}
export async function getWeights() {
  return (await db.all('weights')).sort((a, b) => a.date.localeCompare(b.date));
}

// ---- Streak: consecutive days with at least one entry, ending today (or yesterday) ----
export async function getStreak() {
  const today = todayKey();
  const d = new Date();
  d.setDate(d.getDate() - 120);
  const from = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const dates = new Set((await getEntriesRange(from, today)).map(e => e.date));
  let streak = 0;
  const cur = new Date();
  if (!dates.has(today)) cur.setDate(cur.getDate() - 1);
  for (;;) {
    const k = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`;
    if (!dates.has(k)) break;
    streak++;
    cur.setDate(cur.getDate() - 1);
  }
  return streak;
}

// ---- Backup / restore ----
const BACKUP_STORES = ['entries', 'foods', 'days', 'weights', 'aiMemory', 'meals'];

export async function exportAll() {
  // Never write the API key into a backup file.
  const out = { app: 'macrolens', version: 1, exportedAt: new Date().toISOString(), settings: { ...settings, ai: { ...settings.ai, apiKey: '' } } };
  for (const s of BACKUP_STORES) {
    const rows = await db.all(s);
    out[s] = s === 'aiMemory' ? rows.map(r => ({ ...r, emb: Array.from(r.emb) })) : rows;
  }
  return out;
}

export async function importAll(data) {
  if (data?.app !== 'macrolens') throw new Error('Not a Macrolens backup file');
  for (const s of BACKUP_STORES) {
    if (!Array.isArray(data[s])) continue;
    const rows = s === 'aiMemory' ? data[s].map(r => ({ ...r, emb: Float32Array.from(r.emb) })) : data[s];
    await db.bulkPut(s, rows);
  }
  if (data.settings) {
    const ai = { ...data.settings.ai };
    if (!ai.apiKey) ai.apiKey = settings.ai.apiKey; // backups never carry the key; keep this device's
    await saveSettings({ ...data.settings, ai, onboarded: true });
  }
  emit('entries', { action: 'import' });
  emit('foods', {});
}

export async function resetAll() {
  for (const s of ['entries', 'foods', 'days', 'weights', 'aiMemory', 'settings', 'chats', 'meals']) await db.clear(s);
  settings = structuredClone(DEFAULT_SETTINGS);
}
