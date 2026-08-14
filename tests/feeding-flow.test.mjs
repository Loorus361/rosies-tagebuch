import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

function gramsByKind(items, field) {
  return Object.fromEntries(items.map((item) => [item.kind, item[field]]));
}

test("runs the complete daily feeding flow without changing future defaults", async (t) => {
  const miniflare = new Miniflare({
    modules: true,
    scriptPath: fileURLToPath(new URL("../.wrangler/feeding-flow-worker.mjs", import.meta.url)),
    d1Databases: ["DB"],
  });
  t.after(() => miniflare.dispose());
  const db = await miniflare.getD1Database("DB");
  for (const migrationName of ["0000_loose_sabra.sql", "0001_rare_emma_frost.sql"]) {
    const migration = await readFile(new URL(`../drizzle/${migrationName}`, import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }

  async function request(path, { method = "GET", body, owner = "qa-owner" } = {}) {
    const response = await miniflare.dispatchFetch(`http://localhost${path}`, {
      method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "oai-authenticated-user-id": owner,
        "oai-authenticated-user-email": `${owner}@example.test`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await response.json();
    return { response, json };
  }

  async function post(body, owner) {
    const result = await request("/api/feeding", { method: "POST", body, owner });
    assert.equal(result.response.status, 200, JSON.stringify(result.json));
    return result.json;
  }

  await post({ action: "create_item", name: "QA Nassfutter", kind: "wet" });
  await post({ action: "create_item", name: "QA Trockenfutter", kind: "dry" });
  let state = (await request(`/api/feeding?date=${today}`)).json;
  const wet = state.feedItems.find((item) => item.kind === "wet");
  const dry = state.feedItems.find((item) => item.kind === "dry");
  assert.ok(wet && dry);

  await post({
    action: "save_plan",
    effectiveDate: today,
    mealCount: 3,
    items: [
      { feedItemId: wet.id, dailyGrams: 90 },
      { feedItemId: dry.id, dailyGrams: 30 },
    ],
  });
  state = (await request(`/api/feeding?date=${today}`)).json;
  assert.equal(state.day.mealCount, 3);
  assert.equal(state.day.meals.length, 3);
  assert.ok(state.day.meals.every((meal) => !meal.extra));
  assert.deepEqual(gramsByKind(state.day.meals[0].allocations, "plannedGrams"), { wet: 30, dry: 10 });

  const firstMeal = state.day.meals[0];
  await post({
    action: "save_meal",
    mealId: firstMeal.id,
    actuals: firstMeal.allocations.map((item) => ({ feedItemId: item.id, actualGrams: item.plannedGrams })),
  });
  state = (await request(`/api/feeding?date=${today}`)).json;
  assert.equal(state.day.meals[0].completed, true);
  assert.deepEqual(gramsByKind(state.day.totals, "remainingGrams"), { wet: 60, dry: 20 });

  const secondMeal = state.day.meals.find((meal) => !meal.completed);
  await post({
    action: "save_meal",
    mealId: secondMeal.id,
    actuals: secondMeal.allocations.map((item) => ({
      feedItemId: item.id,
      actualGrams: item.kind === "wet" ? 25 : 8,
    })),
  });
  state = (await request(`/api/feeding?date=${today}`)).json;
  assert.deepEqual(gramsByKind(state.day.totals, "remainingGrams"), { wet: 35, dry: 12 });
  assert.deepEqual(
    gramsByKind(state.day.meals.find((meal) => !meal.completed).allocations, "plannedGrams"),
    { wet: 35, dry: 12 },
  );

  await post({ action: "add_extra_meal", date: today });
  state = (await request(`/api/feeding?date=${today}`)).json;
  assert.equal(state.day.mealCount, 3, "the permanent standard count stays unchanged");
  assert.equal(state.day.meals.length, 4);
  assert.equal(state.day.meals.filter((meal) => meal.extra).length, 1);
  const openSuggestions = state.day.meals.filter((meal) => !meal.completed)
    .map((meal) => gramsByKind(meal.allocations, "plannedGrams"));
  assert.deepEqual(openSuggestions, [{ wet: 17.5, dry: 6 }, { wet: 17.5, dry: 6 }]);

  const extraMeal = state.day.meals.find((meal) => meal.extra);
  await post({
    action: "save_meal",
    mealId: extraMeal.id,
    actuals: extraMeal.allocations.map((item) => ({ feedItemId: item.id, actualGrams: item.plannedGrams })),
  });
  state = (await request(`/api/feeding?date=${today}`)).json;
  assert.deepEqual(gramsByKind(state.day.totals, "remainingGrams"), { wet: 17.5, dry: 6 });

  await post({
    action: "save_plan",
    effectiveDate: today,
    mealCount: 3,
    items: [
      { feedItemId: wet.id, dailyGrams: 100 },
      { feedItemId: dry.id, dailyGrams: 40 },
    ],
  });
  state = (await request(`/api/feeding?date=${today}`)).json;
  assert.equal(state.day.mealCount, 3);
  assert.equal(state.day.meals.length, 4);
  assert.equal(state.day.meals.filter((meal) => meal.extra).length, 1);
  assert.equal(state.day.meals.find((meal) => meal.extra).completed, true);
  assert.deepEqual(gramsByKind(state.day.totals, "remainingGrams"), { wet: 27.5, dry: 16 });
  assert.deepEqual(
    gramsByKind(state.day.meals.find((meal) => !meal.completed).allocations, "plannedGrams"),
    { wet: 27.5, dry: 16 },
  );

  const future = (await request(`/api/feeding?date=${tomorrow}`)).json;
  assert.equal(future.day.virtual, true);
  assert.equal(future.day.mealCount, 3);
  assert.equal(future.day.meals.length, 3);
  assert.ok(future.day.meals.every((meal) => !meal.extra));

  const isolated = (await request(`/api/feeding?date=${today}`, { owner: "other-owner" })).json;
  assert.deepEqual(isolated.feedItems, []);
  assert.equal(isolated.day, null);
  const rejected = await request("/api/feeding", {
    method: "POST",
    owner: "other-owner",
    body: { action: "add_extra_meal", date: today },
  });
  assert.equal(rejected.response.status, 400);
});
