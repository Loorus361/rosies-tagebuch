import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const outputDirectory = mkdtempSync(join(tmpdir(), "rosie-feeding-energy-"));
const modulePath = join(outputDirectory, "feeding-energy.mjs");
execFileSync("npx", ["--no-install", "esbuild", fileURLToPath(new URL("../lib/feeding-energy.ts", import.meta.url)), "--bundle", "--format=esm", "--platform=node", `--outfile=${modulePath}`]);
const { balanceDay, rebalanceMealDrafts, roundPlannedGramVector } = await import(modulePath);

const allocation = (id, name, kind, plannedGrams, actualGrams = null) => ({
  id, name, kind, plannedGrams, actualGrams,
});

test("bounded planned-vector rounding picks the closest 5 g candidate", () => {
  const rounded = roundPlannedGramVector([{ grams: 23.875, kcalPer100g: 100 }], 23.875);
  assert.deepEqual(rounded, [25]);
  assert.equal(rounded[0] % 5, 0);
});

test("explicit target kcal uses calorie-share deficits and keeps completed meals", () => {
  const completed = {
    id: "meal-1", number: 1, extra: false, completed: true,
    completedAt: "2026-09-16T08:00:00+02:00", recordedVia: "app",
    allocations: [allocation("wet", "Wet", "wet", 50, 100), allocation("dry", "Dry", "dry", 50, 0)],
    medications: [],
  };
  const day = {
    id: "day-1", date: "2026-09-16", mealCount: 2, effectiveDate: "2026-09-16", virtual: false,
    targetKcal: 900,
    totals: [
      { id: "wet", name: "Wet", kind: "wet", targetGrams: 100, actualGrams: 100, remainingGrams: 0, caloriePercent: 60 },
      { id: "dry", name: "Dry", kind: "dry", targetGrams: 100, actualGrams: 0, remainingGrams: 100, caloriePercent: 40 },
    ],
    meals: [completed, {
      id: "meal-2", number: 2, extra: false, completed: false,
      completedAt: null, recordedVia: null,
      allocations: [allocation("wet", "Wet", "wet", 50), allocation("dry", "Dry", "dry", 50)],
      medications: [],
    }],
  };
  const result = balanceDay(day, new Map([["wet", 100], ["dry", 400]]));
  assert.equal(result.balance.mode, "energy");
  assert.equal(result.balance.targetKcal, 900);
  assert.equal(result.balance.actualKcal, 100);
  assert.equal(result.meals[0], completed);
  assert.deepEqual(result.totals.map((item) => item.targetGrams), [540, 90]);
  assert.deepEqual(result.totals.map((item) => item.remainingGrams), [440, 90]);
  assert.deepEqual(result.meals[1].allocations.map((item) => item.plannedGrams), [440, 90]);
  assert.deepEqual(result.meals[1].allocations.map((item) => item.kcalPer100g), [100, 400]);
  assert.deepEqual(result.meals[1].allocations.map((item) => item.plannedGrams), result.totals.map((item) => item.remainingGrams));
});

test("legacy days without targetKcal keep the former gram and energy behavior", () => {
  const day = {
    id: "legacy-day", date: "2026-09-16", mealCount: 2, effectiveDate: "2026-09-16", virtual: false,
    totals: [
      { id: "a", name: "A", kind: "dry", targetGrams: 100, actualGrams: 150, remainingGrams: 0 },
      { id: "b", name: "B", kind: "dry", targetGrams: 100, actualGrams: 0, remainingGrams: 100 },
    ],
    meals: [1, 2].map((number) => ({
      id: `meal-${number}`, number, extra: false, completed: false,
      completedAt: null, recordedVia: null,
      allocations: [allocation("a", "A", "dry", 50), allocation("b", "B", "dry", 50)],
      medications: [],
    })),
  };
  const result = balanceDay(day, new Map([["a", 400], ["b", 400]]));
  assert.equal(result.balance.mode, "energy");
  assert.deepEqual(result.totals.map((item) => item.remainingGrams), [0, 50]);
  assert.deepEqual(result.meals.map((meal) => meal.allocations.map((item) => item.plannedGrams)), [[0, 25], [0, 25]]);
  assert.deepEqual(result.meals[0].allocations.map((item) => item.kcalPer100g), [400, 400]);
});

test("manual meal balancing preserves locked strings and zeros free values after overbudget", () => {
  const allocations = [
    { id: "wet", plannedGrams: 30, kcalPer100g: 100 },
    { id: "dry", plannedGrams: 10, kcalPer100g: 400 },
  ];
  assert.deepEqual(
    rebalanceMealDrafts(allocations, 70, { wet: "", dry: "10" }, new Set(["wet", "dry"])),
    { wet: "", dry: "10" },
  );
  assert.deepEqual(
    rebalanceMealDrafts(allocations, 70, { wet: "100", dry: "" }, new Set(["wet"])),
    { wet: "100", dry: "0" },
  );
});
