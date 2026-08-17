import assert from "node:assert/strict";
import test from "node:test";
import {
  formatElapsedSinceMeal,
  formatExactMealTime,
  formatRoundedMealTime,
} from "../.wrangler/feeding-time.mjs";

test("keeps exact Berlin time for editing and rounds only the visible time to five minutes", () => {
  assert.equal(formatExactMealTime("2026-08-14T10:02:29.987+02:00"), "10:02:29");
  assert.equal(formatRoundedMealTime("2026-08-14T10:02:29.987+02:00"), "10:00 Uhr");
  assert.equal(formatRoundedMealTime("2026-08-14T10:02:30.000+02:00"), "10:05 Uhr");
  assert.equal(formatRoundedMealTime("2026-08-14T10:07:29.999+02:00"), "10:05 Uhr");
  assert.equal(formatRoundedMealTime("2026-08-14T10:07:30.000+02:00"), "10:10 Uhr");
  assert.equal(formatRoundedMealTime("2026-08-14T23:58:00.000+02:00"), "00:00 Uhr");
});

test("formats the live elapsed time since the last meal", () => {
  const mealTime = "2026-08-14T10:00:00.000+02:00";
  assert.equal(formatElapsedSinceMeal(mealTime, new Date("2026-08-14T08:00:30.000Z").valueOf()), "Gerade eben");
  assert.equal(formatElapsedSinceMeal(mealTime, new Date("2026-08-14T10:14:00.000Z").valueOf()), "2 Std. 14 Min.");
  assert.equal(formatElapsedSinceMeal(mealTime, new Date("2026-08-15T11:05:00.000Z").valueOf()), "1 Tag 3 Std. 5 Min.");
  assert.equal(formatElapsedSinceMeal("not-a-date"), "");
});
