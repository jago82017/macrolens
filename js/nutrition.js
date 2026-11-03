// Nutrition math: scaling, totals, and the automatic macro calculator.

import { clamp } from './util.js';

export const NUTRIENTS = ['kcal', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'satFat', 'sodium'];
export const MACROS = [
  { id: 'protein', name: 'Protein', short: 'P', kcal: 4 },
  { id: 'carbs', name: 'Carbs', short: 'C', kcal: 4 },
  { id: 'fat', name: 'Fat', short: 'F', kcal: 9 },
];

export function scale(per100 = {}, grams = 100) {
  const f = (+grams || 0) / 100;
  const out = {};
  for (const k of NUTRIENTS) if (per100[k] != null && !Number.isNaN(+per100[k])) out[k] = +per100[k] * f;
  return out;
}

export function sum(list) {
  const out = { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, satFat: 0, sodium: 0 };
  for (const e of list) for (const k of NUTRIENTS) out[k] += +e[k] || 0;
  return out;
}

export const kcalFromMacros = (p = 0, c = 0, f = 0) => p * 4 + c * 4 + f * 9;

// Share of energy from each macro (0..1), used for split bars.
export function macroSplit({ protein = 0, carbs = 0, fat = 0 }) {
  const total = kcalFromMacros(protein, carbs, fat) || 1;
  return { protein: (protein * 4) / total, carbs: (carbs * 4) / total, fat: (fat * 9) / total };
}

// ---- Calculator ----
export const ACTIVITY = [
  { v: 1.2, label: 'Sedentary', desc: 'Desk job, little or no exercise' },
  { v: 1.375, label: 'Lightly active', desc: '1–3 workouts a week' },
  { v: 1.55, label: 'Moderately active', desc: '3–5 workouts a week' },
  { v: 1.725, label: 'Very active', desc: '6–7 hard workouts a week' },
  { v: 1.9, label: 'Athlete', desc: 'Physical job or twice-daily training' },
];

export const GOALS = [
  { id: 'lose', label: 'Lose fat', emoji: '🔥' },
  { id: 'maintain', label: 'Maintain', emoji: '⚖️' },
  { id: 'gain', label: 'Build muscle', emoji: '💪' },
];

export const DIETS = [
  { id: 'balanced', label: 'Balanced', desc: '30% fat, protein 1.8 g/kg', proteinPerKg: 1.8, fatPct: 0.3 },
  { id: 'highprotein', label: 'High protein', desc: '25% fat, protein 2.2 g/kg', proteinPerKg: 2.2, fatPct: 0.25 },
  { id: 'lowcarb', label: 'Low carb', desc: '20% carbs, rest from fat', proteinPerKg: 2.0, carbPct: 0.2 },
  { id: 'keto', label: 'Keto', desc: '~25 g carbs, high fat', proteinPerKg: 1.7, carbGrams: 25 },
  { id: 'endurance', label: 'Endurance', desc: 'Carb-forward, 22% fat', proteinPerKg: 1.6, fatPct: 0.22 },
];

/**
 * Mifflin–St Jeor BMR × activity factor → TDEE, then goal adjustment and a diet-style macro split.
 * Protein is anchored to body weight (capped at a BMI-27 reference weight so it stays sane for larger bodies).
 */
export function calcTargets(p) {
  const weightKg = +p.weightKg || 70;
  const heightCm = +p.heightCm || 170;
  const age = +p.age || 30;
  const activity = +p.activity || 1.55;
  const female = p.sex === 'female';

  const bmr = 10 * weightKg + 6.25 * heightCm - 5 * age + (female ? -161 : 5);
  const tdee = bmr * activity;

  const weekly = (+p.rate || 0.5) * 7700; // kcal per kg of body fat
  let delta = 0;
  if (p.goal === 'lose') delta = -Math.min(weekly / 7, tdee * 0.25);
  if (p.goal === 'gain') delta = Math.min(weekly / 7, tdee * 0.15);

  let kcal = Math.max(tdee + delta, female ? 1200 : 1500);
  kcal = Math.round(kcal / 10) * 10;

  const diet = DIETS.find(d => d.id === p.diet) || DIETS[0];
  const h = heightCm / 100;
  const refKg = Math.min(weightKg, 27 * h * h);
  let protein = diet.proteinPerKg * refKg * (p.goal === 'lose' ? 1.1 : 1);
  let carbs, fat;

  if (diet.carbGrams != null) {
    carbs = diet.carbGrams;
    fat = (kcal - protein * 4 - carbs * 4) / 9;
  } else if (diet.carbPct != null) {
    carbs = (kcal * diet.carbPct) / 4;
    fat = (kcal - protein * 4 - carbs * 4) / 9;
  } else {
    fat = (kcal * diet.fatPct) / 9;
    carbs = (kcal - protein * 4 - fat * 9) / 4;
  }

  const minFat = 0.6 * weightKg; // hormonal floor
  if (fat < minFat) { fat = minFat; carbs = (kcal - protein * 4 - fat * 9) / 4; }
  if (carbs < 0) { carbs = 0; protein = (kcal - fat * 9) / 4; }

  return {
    bmr: Math.round(bmr),
    tdee: Math.round(tdee),
    delta: Math.round(delta),
    weeklyChangeKg: Math.round(((delta * 7) / 7700) * 100) / 100,
    kcal,
    protein: Math.round(protein),
    carbs: Math.round(carbs),
    fat: Math.round(fat),
    fiber: Math.round(clamp((kcal / 1000) * 14, 20, 45)),
    water: Math.round((weightKg * 35) / 100) * 100,
  };
}

// ---- Units ----
export const kgToLb = kg => kg * 2.20462;
export const lbToKg = lb => lb / 2.20462;
export const cmToFtIn = cm => { const inches = cm / 2.54; return { ft: Math.floor(inches / 12), in: Math.round(inches % 12) }; };
export const ftInToCm = (ft, inch) => (ft * 12 + inch) * 2.54;
