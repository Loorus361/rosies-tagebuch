import type { DayView, DayTotal } from "./feeding-types";

const round = (value: number) => Math.round(value * 10) / 10;

/** Derive suggestions from actual entries, never from previously rounded suggestions. */
export function balanceDay(day: DayView, energy: Map<string, number | null>): DayView {
  const totals = day.totals.map((item) => ({ ...item, kcalPer100g: energy.get(item.id) ?? null }));
  const relevant = totals.filter((item) => item.targetGrams > 0 || item.actualGrams > 0);
  const allKnown = relevant.length > 0 && relevant.every((item) => (item.kcalPer100g ?? 0) > 0);
  const dry = totals.filter((item) => item.kind === "dry");
  const dryKnown = dry.every((item) => (item.kcalPer100g ?? 0) > 0);
  const groups: Array<{ items: DayTotal[]; weighted: boolean }> = allKnown
    ? [{ items: relevant, weighted: true }]
    : [
      { items: dry, weighted: dryKnown },
      ...totals.filter((item) => item.kind === "wet").map((item) => ({ items: [item], weighted: false })),
    ];
  const remaining = new Map<string, number>();
  for (const group of groups) {
    const weight = (item: DayTotal) => group.weighted ? (item.kcalPer100g ?? 0) / 100 : 1;
    const target = group.items.reduce((sum, item) => sum + item.targetGrams * weight(item), 0);
    const actual = group.items.reduce((sum, item) => sum + item.actualGrams * weight(item), 0);
    const budget = Math.max(0, target - actual);
    // Preserve the intended mix as far as possible; excess of one food offsets deficits of others.
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
        return { ...item, plannedGrams: (base + (open.indexOf(meal) < tenths % open.length ? 1 : 0)) / 10 };
      }),
    }),
  };
}
