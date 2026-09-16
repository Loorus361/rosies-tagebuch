import type { DayView, DayTotal } from "./feeding-types";

const round = (value: number) => Math.round(value * 10) / 10;
const EPSILON = 1e-9;

type PlannedGramVectorItem = {
  grams: number;
  kcalPer100g?: number | null;
};

/**
 * Round a planned vector to a sensible step while keeping its energy close to
 * the requested budget. The result has the same order and length as `items`.
 *
 * Each component is limited to its floor/ceil step around the ideal value.
 * This keeps the mix close to the requested shares and avoids a knapsack-style
 * search. The small bounded coordinate pass chooses the best admissible
 * increments by energy error and then share error.
 */
export function roundPlannedGramVector(
  items: readonly PlannedGramVectorItem[],
  targetKcal: number | null | undefined,
  step = 5,
): number[] {
  const safeStep = Number.isFinite(step) && step > 0 ? step : 5;
  const ideal = items.map((item) => Math.max(0, finiteNumber(item.grams) ?? 0));
  const density = items.map((item) => positiveNumber(item.kcalPer100g));
  const budget = finiteNumber(targetKcal);

  if (budget == null || budget < 0) {
    return ideal.map((grams) => nearestStep(grams, safeStep));
  }

  const floors = ideal.map((grams) => floorStep(grams, safeStep));
  const ceils = ideal.map((grams) => ceilStep(grams, safeStep));
  const values = floors.slice();
  // Every component can move at most once, from its floor to its ceil. This
  // is deliberately bounded: it rounds the vector without searching an
  // unbounded combination space. A final ceil may be a little over budget
  // when it is closer in kcal than the floor.
  for (let iteration = 0; iteration < items.length; iteration += 1) {
    const candidates = values
      .map((value, index) => value + safeStep <= ceils[index] + EPSILON ? index : -1)
      .filter((index) => index >= 0);
    if (candidates.length === 0) break;
    const candidate = chooseCandidate(candidates, values, safeStep, floors, ceils, ideal, density, budget, safeStep);
    if (candidate < 0) break;
    values[candidate] += safeStep;
  }

  return values.map((value) => roundToStep(value, safeStep));
}

/** Input accepted by the same-meal draft balancing helper. */
export type MealDraftAllocation = {
  id: string;
  /** Existing meal allocations call this field `plannedGrams`. */
  plannedGrams?: number;
  /** `grams` is accepted for small standalone callers and math tests. */
  grams?: number;
  kcalPer100g?: number | null;
};

/**
 * Recompute only unlocked meal drafts against the original meal kcal budget.
 *
 * Locked draft strings are copied verbatim, including an empty string while a
 * user is midway through editing. Invalid or empty locked values contribute
 * zero kcal. Unlocked values use their original planned kcal share and are
 * rounded to 5 g. If locked values already consume the budget, every unlocked
 * value becomes "0".
 */
export function rebalanceMealDrafts(
  allocations: readonly MealDraftAllocation[],
  mealBudgetKcal: number,
  drafts: Readonly<Record<string, string>>,
  lockedIds: ReadonlySet<string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  const budget = Math.max(0, finiteNumber(mealBudgetKcal) ?? 0);
  let lockedKcal = 0;
  const unlocked = allocations.filter((allocation) => !lockedIds.has(allocation.id));

  for (const allocation of allocations) {
    if (lockedIds.has(allocation.id)) {
      const draft = drafts[allocation.id] ?? "";
      result[allocation.id] = draft;
      const grams = parseDraftGrams(draft);
      const kcalPer100g = positiveNumber(allocation.kcalPer100g);
      if (grams != null && kcalPer100g != null) lockedKcal += grams * kcalPer100g / 100;
    }
  }

  const remainingKcal = Math.max(0, budget - lockedKcal);
  if (unlocked.length === 0) return result;
  if (lockedKcal > budget + EPSILON) {
    unlocked.forEach((allocation) => { result[allocation.id] = "0"; });
    return result;
  }

  const shareWeights = unlocked.map((allocation) => {
    const plannedGrams = Math.max(0, finiteNumber(allocation.plannedGrams ?? allocation.grams) ?? 0);
    const kcalPer100g = positiveNumber(allocation.kcalPer100g);
    return kcalPer100g == null ? 0 : plannedGrams * kcalPer100g / 100;
  });
  const totalShare = shareWeights.reduce((sum, value) => sum + value, 0);
  const fallbackShare = unlocked.length > 0 ? 1 / unlocked.length : 0;
  const ideal = unlocked.map((allocation, index) => {
    const kcalPer100g = positiveNumber(allocation.kcalPer100g);
    if (kcalPer100g == null) return 0;
    const share = totalShare > EPSILON ? shareWeights[index] / totalShare : fallbackShare;
    return remainingKcal * share * 100 / kcalPer100g;
  });
  const rounded = roundPlannedGramVector(
    unlocked.map((allocation, index) => ({ grams: ideal[index], kcalPer100g: allocation.kcalPer100g })),
    remainingKcal,
    5,
  );
  unlocked.forEach((allocation, index) => { result[allocation.id] = String(rounded[index]); });
  return result;
}

/** Derive suggestions from actual entries, never from previously rounded suggestions. */
export function balanceDay(day: DayView, energy: Map<string, number | null>): DayView {
  const explicitTarget = finiteNumber(day.targetKcal);
  // This branch intentionally preserves the pre-plan-target algorithm byte for
  // byte for historical/legacy days.
  if (explicitTarget == null) return balanceLegacyDay(day, energy);
  return balanceExplicitDay(day, energy, Math.max(0, explicitTarget));
}

function balanceLegacyDay(day: DayView, energy: Map<string, number | null>): DayView {
  const totals = day.totals.map((item) => ({ ...item, kcalPer100g: energy.get(item.id) ?? null }));
  const relevant = totals.filter((item) => item.targetGrams > 0 || item.actualGrams > 0);
  const allKnown = relevant.length > 0 && relevant.every((item) => (item.kcalPer100g ?? 0) > 0);
  const known = relevant.filter((item) => (item.kcalPer100g ?? 0) > 0);
  const unknown = relevant.filter((item) => !(item.kcalPer100g! > 0));
  const groups: Array<{ items: DayTotal[]; weighted: boolean }> = [
    { items: known, weighted: true },
    { items: unknown.filter((item) => item.kind === "dry"), weighted: false },
    ...unknown.filter((item) => item.kind === "wet").map((item) => ({ items: [item], weighted: false })),
  ];
  const remaining = new Map<string, number>();
  for (const group of groups) {
    const weight = (item: DayTotal) => group.weighted ? (item.kcalPer100g ?? 0) / 100 : 1;
    const target = group.items.reduce((sum, item) => sum + item.targetGrams * weight(item), 0);
    const actual = group.items.reduce((sum, item) => sum + item.actualGrams * weight(item), 0);
    const budget = Math.max(0, target - actual);
    const deficits = group.items.reduce((sum, item) => sum + Math.max(0, item.targetGrams - item.actualGrams) * weight(item), 0);
    for (const item of group.items) {
      remaining.set(item.id, deficits > 0 ? round(Math.max(0, item.targetGrams - item.actualGrams) * budget / deficits) : 0);
    }
  }
  const open = day.meals.filter((meal) => !meal.completed);
  return {
    ...day,
    balance: {
      mode: allKnown ? "energy" : "approximate",
      targetKcal: allKnown ? round(relevant.reduce((sum, item) => sum + item.targetGrams * item.kcalPer100g! / 100, 0)) : null,
      actualKcal: allKnown ? round(relevant.reduce((sum, item) => sum + item.actualGrams * item.kcalPer100g! / 100, 0)) : null,
    },
    totals: totals.map((item) => ({ ...item, remainingGrams: remaining.get(item.id) ?? 0 })),
    meals: day.meals.map((meal) => meal.completed ? meal : {
      ...meal,
      allocations: meal.allocations.map((item) => {
        const tenths = Math.round((remaining.get(item.id) ?? 0) * 10);
        const base = Math.floor(tenths / open.length);
        return {
          ...enrichAllocation(item, energy),
          plannedGrams: (base + (open.indexOf(meal) < tenths % open.length ? 1 : 0)) / 10,
        };
      }),
    }),
  };
}

function balanceExplicitDay(day: DayView, energy: Map<string, number | null>, targetKcal: number): DayView {
  const totals = day.totals.map((item) => ({
    ...item,
    kcalPer100g: energy.get(item.id) ?? item.kcalPer100g ?? null,
  }));
  const relevant = totals.filter((item) => item.targetGrams > 0 || item.actualGrams > 0);
  const allKnown = relevant.length > 0 && relevant.every((item) => positiveNumber(item.kcalPer100g) != null);
  const known = relevant.filter((item) => positiveNumber(item.kcalPer100g) != null);
  const shareBasis = deriveShareBasis(relevant);
  const desiredKcal = new Map<string, number>();
  relevant.forEach((item, index) => desiredKcal.set(item.id, targetKcal * (shareBasis[index] ?? 0)));
  const targetGrams = new Map<string, number>();
  known.forEach((item) => {
    const kcalPer100g = item.kcalPer100g!;
    targetGrams.set(item.id, round((desiredKcal.get(item.id) ?? 0) * 100 / kcalPer100g));
  });
  const actualKcal = known.reduce((sum, item) => sum + item.actualGrams * (item.kcalPer100g ?? 0) / 100, 0);
  const residualKcal = Math.max(0, targetKcal - actualKcal);
  const deficits = known.map((item) => Math.max(0, (desiredKcal.get(item.id) ?? 0) - item.actualGrams * (item.kcalPer100g ?? 0) / 100));
  const deficitTotal = deficits.reduce((sum, value) => sum + value, 0);
  const ideal = known.map((item, index) => {
    const kcalPer100g = item.kcalPer100g!;
    const itemKcal = deficitTotal > EPSILON ? residualKcal * deficits[index] / deficitTotal : 0;
    return itemKcal * 100 / kcalPer100g;
  });
  const roundedKnown = roundPlannedGramVector(
    known.map((item, index) => ({ id: item.id, grams: ideal[index], kcalPer100g: item.kcalPer100g })),
    residualKcal,
    5,
  );
  const remaining = new Map<string, number>();
  known.forEach((item, index) => remaining.set(item.id, roundedKnown[index] ?? 0));
  // Unknown foods cannot be converted to kcal safely. Preserve an explicit
  // plan's target budget in the balance, but leave their energy suggestion out
  // rather than pretending that an unknown density is known.
  relevant.filter((item) => !known.includes(item)).forEach((item) => remaining.set(item.id, 0));

  const open = day.meals.filter((meal) => !meal.completed);
  const perMeal = new Map<string, number[]>();
  remaining.forEach((grams, id) => perMeal.set(id, splitByStep(grams, open.length, 5)));
  const meals = day.meals.map((meal) => {
    if (meal.completed) return meal;
    const mealIndex = open.indexOf(meal);
    return {
      ...meal,
      allocations: meal.allocations.map((item) => ({
        ...enrichAllocation(item, energy),
        plannedGrams: perMeal.get(item.id)?.[mealIndex] ?? 0,
      })),
    };
  });
  return {
    ...day,
    balance: {
      mode: allKnown ? "energy" : "approximate",
      targetKcal: round(targetKcal),
      actualKcal: allKnown ? round(actualKcal) : null,
    },
    totals: totals.map((item) => ({
      ...item,
      targetGrams: targetGrams.get(item.id) ?? item.targetGrams,
      remainingGrams: remaining.get(item.id) ?? 0,
    })),
    meals,
  };
}

function enrichAllocation<T extends { id: string; kcalPer100g?: number | null }>(item: T, energy: Map<string, number | null>): T {
  return energy.has(item.id) ? { ...item, kcalPer100g: energy.get(item.id) ?? null } : item;
}

function deriveShareBasis(items: readonly DayTotal[]): number[] {
  const fallback = items.map((item) => {
    const kcalPer100g = positiveNumber(item.kcalPer100g);
    return kcalPer100g == null
      ? Math.max(0, item.targetGrams)
      : Math.max(0, item.targetGrams * kcalPer100g / 100);
  });
  const raw = items.map((item, index) => {
    const value = finiteNumber(item.caloriePercent);
    return value != null && value >= 0 ? value : fallback[index];
  });
  const total = raw.reduce((sum, value) => sum + value, 0);
  if (total <= EPSILON) return items.map(() => items.length > 0 ? 1 / items.length : 0);
  return raw.map((value) => value / total);
}

function splitByStep(total: number, count: number, step: number): number[] {
  if (count <= 0) return [];
  const units = Math.max(0, Math.round(total / step));
  const base = Math.floor(units / count);
  const remainder = units - base * count;
  return Array.from({ length: count }, (_, index) => (base + (index < remainder ? 1 : 0)) * step);
}

function chooseCandidate(
  candidates: readonly number[],
  values: readonly number[],
  delta: number,
  floors: readonly number[],
  ceils: readonly number[],
  ideal: readonly number[],
  density: readonly (number | null)[],
  budget: number,
  step: number,
): number {
  let best = -1;
  let bestEnergyError = Number.POSITIVE_INFINITY;
  let bestShareError = Number.POSITIVE_INFINITY;
  const currentEnergyError = Math.abs(budget - vectorKcal(values, density));
  const currentShareError = values.reduce((sum, value, itemIndex) => {
    const scale = Math.max(step, ideal[itemIndex]);
    return sum + ((value - ideal[itemIndex]) / scale) ** 2;
  }, 0);
  for (const index of candidates) {
    const next = values.slice();
    next[index] += delta;
    if (next[index] < floors[index] - EPSILON || next[index] > ceils[index] + EPSILON) continue;
    const energyError = Math.abs(budget - vectorKcal(next, density));
    const shareError = next.reduce((sum, value, itemIndex) => {
      const scale = Math.max(step, ideal[itemIndex]);
      return sum + ((value - ideal[itemIndex]) / scale) ** 2;
    }, 0);
    if (energyError < bestEnergyError - EPSILON
      || (Math.abs(energyError - bestEnergyError) <= EPSILON && shareError < bestShareError - EPSILON)) {
      best = index;
      bestEnergyError = energyError;
      bestShareError = shareError;
    }
  }
  if (best < 0) return -1;
  if (bestEnergyError > currentEnergyError + EPSILON) return -1;
  if (Math.abs(bestEnergyError - currentEnergyError) <= EPSILON
    && bestShareError >= currentShareError - EPSILON) return -1;
  return best;
}

function vectorKcal(values: readonly number[], density: readonly (number | null)[]): number {
  return values.reduce((sum, grams, index) => sum + grams * (density[index] ?? 0) / 100, 0);
}

function positiveNumber(value: unknown): number | null {
  const number = finiteNumber(value);
  return number != null && number > 0 ? number : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseDraftGrams(value: string): number | null {
  if (value.trim() === "") return null;
  const number = Number(value.trim().replace(",", "."));
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function floorStep(value: number, step: number): number {
  return Math.floor((value + EPSILON) / step) * step;
}

function ceilStep(value: number, step: number): number {
  return Math.ceil((value - EPSILON) / step) * step;
}

function nearestStep(value: number, step: number): number {
  return roundToStep(Math.round(value / step) * step, step);
}

function roundToStep(value: number, step: number): number {
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)) + 2);
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
