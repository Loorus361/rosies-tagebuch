import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());
const tomorrowDate = new Date(`${today}T12:00:00Z`);
tomorrowDate.setUTCDate(tomorrowDate.getUTCDate() + 1);
const tomorrow = tomorrowDate.toISOString().slice(0, 10);

test("persists and validates explicit calorie plans", async (t) => {
  const miniflare = new Miniflare({
    modules: true,
    scriptPath: fileURLToPath(new URL("../.wrangler/feeding-flow-worker.mjs", import.meta.url)),
    d1Databases: ["DB"],
  });
  t.after(() => miniflare.dispose());
  const db = await miniflare.getD1Database("DB");
  for (const migrationName of (await readdir(new URL("../drizzle/", import.meta.url)))
    .filter((name) => name.endsWith(".sql")).sort()) {
    const migration = await readFile(new URL(`../drizzle/${migrationName}`, import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }

  async function request(body) {
    const response = await miniflare.dispatchFetch("http://localhost/api/feeding", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "oai-authenticated-user-id": "plan-owner",
      },
      body: JSON.stringify(body),
    });
    return { response, json: await response.json() };
  }

  async function post(body) {
    const result = await request(body);
    assert.equal(result.response.status, 200, JSON.stringify(result.json));
    return result.json;
  }

  async function rejected(body, message) {
    const result = await request(body);
    assert.equal(result.response.status, 400, JSON.stringify(result.json));
    if (message) assert.match(result.json.error, message);
  }

  await post({ action: "create_item", name: "Plan Nass", kind: "wet" });
  await post({ action: "create_item", name: "Plan Trocken", kind: "dry" });
  await post({ action: "create_item", name: "Plan Unbekannt", kind: "wet" });
  let state = await (await miniflare.dispatchFetch(`http://localhost/api/feeding?date=${today}`, {
    headers: { "oai-authenticated-user-id": "plan-owner" },
  })).json();
  const wet = state.feedItems.find((item) => item.name === "Plan Nass");
  const dry = state.feedItems.find((item) => item.name === "Plan Trocken");
  const unknown = state.feedItems.find((item) => item.name === "Plan Unbekannt");

  await post({ action: "save_energy", items: [
    { feedItemId: wet.id, kcalPer100g: 400 },
    { feedItemId: dry.id, kcalPer100g: 200 },
  ] });
  await post({
    action: "save_plan",
    effectiveDate: today,
    mealCount: 2,
    targetKcal: 900,
    items: [
      { feedItemId: wet.id, caloriePercent: 50 },
      { feedItemId: dry.id, caloriePercent: 50 },
    ],
  });

  state = await (await miniflare.dispatchFetch(`http://localhost/api/feeding?date=${today}`, {
    headers: { "oai-authenticated-user-id": "plan-owner" },
  })).json();
  assert.equal(state.currentPlan.targetKcal, 900);
  assert.deepEqual(
    Object.fromEntries(state.currentPlan.items.map((item) => [item.id, [item.dailyGrams, item.caloriePercent]])),
    { [wet.id]: [112.5, 50], [dry.id]: [225, 50] },
  );
  assert.equal(state.day.targetKcal, 900);
  assert.deepEqual(
    Object.fromEntries(state.day.totals.map((item) => [item.id, [item.targetGrams, item.caloriePercent]])),
    { [wet.id]: [112.5, 50], [dry.id]: [225, 50] },
  );
  const version = await db.prepare("SELECT target_kcal FROM plan_versions WHERE id = ?")
    .bind(state.currentPlan.id).first();
  assert.equal(version.target_kcal, 900);
  const versionItems = await db.prepare(
    "SELECT feed_item_id, daily_grams, calorie_percent FROM plan_version_items WHERE plan_version_id = ? ORDER BY feed_item_id",
  ).bind(state.currentPlan.id).all();
  assert.deepEqual(
    Object.fromEntries(versionItems.results.map((item) => [item.feed_item_id, [item.daily_grams, item.calorie_percent]])),
    { [wet.id]: [112.5, 50], [dry.id]: [225, 50] },
  );

  await post({
    action: "save_plan",
    effectiveDate: tomorrow,
    mealCount: 2,
    targetKcal: 800,
    items: [
      { feedItemId: wet.id, caloriePercent: 25 },
      { feedItemId: dry.id, caloriePercent: 75 },
    ],
  });
  const futureState = await (await miniflare.dispatchFetch(`http://localhost/api/feeding?date=${tomorrow}`, {
    headers: { "oai-authenticated-user-id": "plan-owner" },
  })).json();
  assert.equal(futureState.day.virtual, true);
  assert.equal(futureState.day.targetKcal, 800);
  assert.deepEqual(
    Object.fromEntries(futureState.day.totals.map((item) => [item.id, item.caloriePercent])),
    { [wet.id]: 25, [dry.id]: 75 },
  );

  const firstMeal = state.day.meals[0];
  const completedActuals = firstMeal.allocations.map((item) => item.plannedGrams);
  await post({
    action: "save_meal",
    mealId: firstMeal.id,
    actuals: firstMeal.allocations.map((item) => ({ feedItemId: item.id, actualGrams: item.plannedGrams })),
  });
  await post({
    action: "save_plan",
    effectiveDate: today,
    mealCount: 2,
    targetKcal: 1000,
    items: [
      { feedItemId: wet.id, caloriePercent: 40 },
      { feedItemId: dry.id, caloriePercent: 60 },
    ],
  });
  state = await (await miniflare.dispatchFetch(`http://localhost/api/feeding?date=${today}`, {
    headers: { "oai-authenticated-user-id": "plan-owner" },
  })).json();
  assert.equal(state.day.targetKcal, 1000);
  assert.equal(state.day.meals.find((meal) => meal.id === firstMeal.id).completed, true);
  assert.deepEqual(
    state.day.meals.find((meal) => meal.id === firstMeal.id).allocations.map((item) => item.actualGrams),
    completedActuals,
  );

  await rejected({
    action: "save_plan",
    effectiveDate: today,
    mealCount: 2,
    targetKcal: 900,
    items: [
      { feedItemId: wet.id, caloriePercent: 40 },
      { feedItemId: dry.id, caloriePercent: 40 },
    ],
  }, /100 %/);
  await rejected({
    action: "save_plan",
    effectiveDate: today,
    mealCount: 2,
    targetKcal: 900,
    items: [
      { feedItemId: wet.id, caloriePercent: 50 },
      { feedItemId: unknown.id, caloriePercent: 50 },
    ],
  }, /Energiegehalt/);
  await rejected({
    action: "save_plan",
    effectiveDate: today,
    mealCount: 2,
    targetKcal: 10001,
    items: [
      { feedItemId: wet.id, caloriePercent: 100 },
    ],
  }, /10.000 kcal/);
  await rejected({
    action: "save_energy",
    items: [{ feedItemId: wet.id, kcalPer100g: null }],
  }, /aktiven Kalorienplan/);
  const energy = await db.prepare(
    "SELECT kcal_per_100g FROM feed_energy_versions WHERE feed_item_id = ? ORDER BY rowid DESC LIMIT 1",
  ).bind(wet.id).first();
  assert.equal(energy.kcal_per_100g, 400);
});
