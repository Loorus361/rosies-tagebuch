import assert from "node:assert/strict";
import test from "node:test";
import { formatExactMealTime, formatRoundedMealTime } from "../.wrangler/feeding-time.mjs";

test("keeps exact Berlin time for editing and rounds only the visible time to five minutes", () => {
  assert.equal(formatExactMealTime("2026-08-14T10:02:29.987+02:00"), "10:02:29");
  assert.equal(formatRoundedMealTime("2026-08-14T10:02:29.987+02:00"), "10:00 Uhr");
  assert.equal(formatRoundedMealTime("2026-08-14T10:02:30.000+02:00"), "10:05 Uhr");
  assert.equal(formatRoundedMealTime("2026-08-14T10:07:29.999+02:00"), "10:05 Uhr");
  assert.equal(formatRoundedMealTime("2026-08-14T10:07:30.000+02:00"), "10:10 Uhr");
  assert.equal(formatRoundedMealTime("2026-08-14T23:58:00.000+02:00"), "00:00 Uhr");
});
