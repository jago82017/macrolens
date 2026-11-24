// "Fits what's left": foods whose normal serving best fills today's remaining macros.

import { BUILTIN_FOODS } from './fooddb.js';
import { allFoods, getSettings } from './store.js';
import { scale } from './nutrition.js';
import { gradeFood } from './grade.js';

const GRADE_BONUS = { A: 0.3, B: 0.15, C: 0, D: -0.25, E: -0.4, F: -0.55 };
const KEYS = ['protein', 'carbs', 'fat'];
const PRIORITY = { protein: 1.6, carbs: 1, fat: 0.7 }; // protein is the hardest target to hit

export async function suggestFoods(totals, targets, n = 3) {
  const left = { kcal: targets.kcal - totals.kcal, protein: targets.protein - totals.protein, carbs: targets.carbs - totals.carbs, fat: targets.fat - totals.fat };
  if (left.kcal < 80) return { left, picks: [] };
  const settings = getSettings();
  const mine = (await allFoods()).filter(f => f.per100?.kcal != null && f.source !== 'ai' && (f.source === 'custom' || f.favorite || f.uses >= 2));
  const mineIds = new Set(mine.map(f => f.id));
  const pool = [...mine, ...BUILTIN_FOODS.filter(f => !mineIds.has(f.id) && !['dessert', 'drink'].includes(f.category))];

  const gap = Object.fromEntries(KEYS.map(k => [k, Math.max(0, left[k])]));
  const need = Object.fromEntries(KEYS.map(k => [k, (gap[k] / Math.max(1, targets[k])) * PRIORITY[k]]));
  const needSum = KEYS.reduce((s, k) => s + need[k], 0) || 1;
  // Aim for a sensible portion for the rest of the day, not one giant plate.
  const hour = new Date().getHours();
  const mealsLeft = hour < 11 ? 3 : hour < 15 ? 2.2 : hour < 20 ? 1.5 : 1;
  const ideal = Math.max(150, Math.min(800, left.kcal / mealsLeft));

  const scored = [];
  for (const food of pool) {
    const grams = food.servings?.[0]?.grams || 100;
    const nut = scale(food.per100, grams);
    if (!(nut.kcal >= 40) || nut.kcal > Math.min(left.kcal * 1.05, ideal * 1.8)) continue;
    let s = 0;
    for (const k of KEYS) {
      const v = nut[k] || 0;
      s += (need[k] / needSum) * (Math.min(v, gap[k]) / Math.max(gap[k], 1));
      const over = v - gap[k];
      if (over > 5) s -= (over / Math.max(targets[k], 1)) * 1.5;
    }
    s -= (Math.abs(nut.kcal - ideal) / ideal) * 0.35;
    if (gap.protein > 20) s += 0.3 * Math.min(1, ((nut.protein || 0) * 4) / nut.kcal / 0.4); // protein-dense foods
    if (mineIds.has(food.id)) s += 0.05;
    if (settings.grades !== false) {
      const g = gradeFood(food, settings);
      if (g) s += GRADE_BONUS[g.letter] || 0;
    }
    scored.push({ food, grams, nut, score: s });
  }
  scored.sort((a, b) => b.score - a.score);

  // Keep the picks varied: one per category.
  const picks = [];
  const seen = new Set();
  for (const x of scored) {
    const cat = x.food.category || x.food.source;
    if (seen.has(cat)) continue;
    seen.add(cat);
    picks.push(x);
    if (picks.length === n) break;
  }
  return { left, picks };
}
