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

  const removalOwner = "removal-owner";
  await post({ action: "create_item", name: "Entfernen Nass", kind: "wet" }, removalOwner);
  await post({ action: "create_item", name: "Entfernen Trocken", kind: "dry" }, removalOwner);
  let removalState = (await request(`/api/feeding?date=${today}`, { owner: removalOwner })).json;
  const removalWet = removalState.feedItems.find((item) => item.kind === "wet");
  const removalDry = removalState.feedItems.find((item) => item.kind === "dry");
  await post({
    action: "save_plan",
    effectiveDate: today,
    mealCount: 3,
    items: [
      { feedItemId: removalWet.id, dailyGrams: 90 },
      { feedItemId: removalDry.id, dailyGrams: 30 },
    ],
  }, removalOwner);
  removalState = (await request(`/api/feeding?date=${today}`, { owner: removalOwner })).json;
  const trackedMeal = removalState.day.meals[0];
  await post({
    action: "save_meal",
    mealId: trackedMeal.id,
    actuals: trackedMeal.allocations.map((item) => ({ feedItemId: item.id, actualGrams: item.plannedGrams })),
  }, removalOwner);
  removalState = (await request(`/api/feeding?date=${today}`, { owner: removalOwner })).json;

  const protectedRemoval = await request("/api/feeding", {
    method: "POST",
    owner: removalOwner,
    body: { action: "remove_meal", mealId: trackedMeal.id },
  });
  assert.equal(protectedRemoval.response.status, 400);
  assert.match(protectedRemoval.json.error, /Tagebucheintrag erhalten/);

  const untrackedThird = removalState.day.meals.find((meal) => meal.number === 3);
  const removedRegular = await post({ action: "remove_meal", mealId: untrackedThird.id }, removalOwner);
  assert.equal(removedRegular.day.mealCount, 3);
  assert.equal(removedRegular.day.meals.length, 2);
  assert.deepEqual(removedRegular.day.meals.map((meal) => meal.number), [1, 2]);
  assert.deepEqual(
    gramsByKind(removedRegular.day.meals.find((meal) => !meal.completed).allocations, "plannedGrams"),
    { wet: 60, dry: 20 },
  );
  const removalFuture = (await request(`/api/feeding?date=${tomorrow}`, { owner: removalOwner })).json;
  assert.equal(removalFuture.day.mealCount, 3);
  assert.equal(removalFuture.day.meals.length, 3);

  const addedForDay = await post({ action: "add_extra_meal", date: today }, removalOwner);
  assert.equal(addedForDay.day.mealCount, 3);
  assert.equal(addedForDay.day.meals.length, 3);
  assert.deepEqual(addedForDay.day.meals.map((meal) => meal.number), [1, 2, 3]);
  assert.equal(addedForDay.day.meals.filter((meal) => meal.extra).length, 1);
  const addedOpenSuggestions = addedForDay.day.meals.filter((meal) => !meal.completed)
    .map((meal) => gramsByKind(meal.allocations, "plannedGrams"));
  assert.deepEqual(addedOpenSuggestions, [{ wet: 30, dry: 10 }, { wet: 30, dry: 10 }]);

  const removableAddedMeal = addedForDay.day.meals.find((meal) => meal.extra);
  const removedAdded = await post({ action: "remove_meal", mealId: removableAddedMeal.id }, removalOwner);
  assert.equal(removedAdded.day.mealCount, 3);
  assert.equal(removedAdded.day.meals.length, 2);
  assert.deepEqual(removedAdded.day.meals.map((meal) => meal.number), [1, 2]);
  assert.equal(removedAdded.day.meals.filter((meal) => meal.extra).length, 0);
  assert.deepEqual(
    gramsByKind(removedAdded.day.meals.find((meal) => !meal.completed).allocations, "plannedGrams"),
    { wet: 60, dry: 20 },
  );

  const foreignRemoval = await request("/api/feeding", {
    method: "POST",
    owner: "other-owner",
    body: { action: "remove_meal", mealId: removedAdded.day.meals[1].id },
  });
  assert.equal(foreignRemoval.response.status, 400);

  const sequenceOwner = "sequence-owner";
  await post({ action: "create_item", name: "Reihenfolge Nass", kind: "wet" }, sequenceOwner);
  await post({ action: "create_item", name: "Reihenfolge Trocken", kind: "dry" }, sequenceOwner);
  let sequenceState = (await request(`/api/feeding?date=${today}`, { owner: sequenceOwner })).json;
  const sequenceWet = sequenceState.feedItems.find((item) => item.kind === "wet");
  const sequenceDry = sequenceState.feedItems.find((item) => item.kind === "dry");
  await post({
    action: "save_plan",
    effectiveDate: today,
    mealCount: 3,
    items: [
      { feedItemId: sequenceWet.id, dailyGrams: 90 },
      { feedItemId: sequenceDry.id, dailyGrams: 30 },
    ],
  }, sequenceOwner);
  sequenceState = (await request(`/api/feeding?date=${today}`, { owner: sequenceOwner })).json;
  const firstSequenceMeal = sequenceState.day.meals[0];
  const originalSecondId = sequenceState.day.meals[1].id;
  const originalThird = sequenceState.day.meals[2];
  const beforeAutomaticTimestamp = Date.now();
  await post({
    action: "save_meal",
    mealId: firstSequenceMeal.id,
    actuals: firstSequenceMeal.allocations.map((item) => ({ feedItemId: item.id, actualGrams: item.plannedGrams })),
  }, sequenceOwner);
  sequenceState = (await request(`/api/feeding?date=${today}`, { owner: sequenceOwner })).json;
  const storedAutomaticTimestamp = sequenceState.day.meals.find((meal) => meal.id === firstSequenceMeal.id).completedAt;
  assert.match(storedAutomaticTimestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+0[12]:00$/);
  assert.ok(new Date(storedAutomaticTimestamp).valueOf() >= beforeAutomaticTimestamp - 1000);
  assert.ok(new Date(storedAutomaticTimestamp).valueOf() <= Date.now() + 1000);

  await post({
    action: "save_meal",
    mealId: originalThird.id,
    actuals: originalThird.allocations.map((item) => ({
      feedItemId: item.id,
      actualGrams: item.kind === "wet" ? 20 : 5,
    })),
  }, sequenceOwner);
  sequenceState = (await request(`/api/feeding?date=${today}`, { owner: sequenceOwner })).json;
  assert.deepEqual(sequenceState.day.meals.map((meal) => meal.id), [firstSequenceMeal.id, originalThird.id, originalSecondId]);
  assert.deepEqual(sequenceState.day.meals.map((meal) => meal.number), [1, 2, 3]);
  assert.deepEqual(sequenceState.day.meals.map((meal) => meal.completed), [true, true, false]);
  assert.deepEqual(
    gramsByKind(sequenceState.day.meals[2].allocations, "plannedGrams"),
    { wet: 40, dry: 15 },
  );

  const beforeTimeCorrectionTotals = gramsByKind(sequenceState.day.totals, "remainingGrams");
  const beforeTimeCorrectionSuggestion = gramsByKind(sequenceState.day.meals[2].allocations, "plannedGrams");
  const movedCompletedMeal = sequenceState.day.meals[1];
  await post({
    action: "save_meal",
    mealId: movedCompletedMeal.id,
    completedTime: "08:17:43",
    actuals: movedCompletedMeal.allocations.map((item) => ({ feedItemId: item.id, actualGrams: item.actualGrams })),
  }, sequenceOwner);
  sequenceState = (await request(`/api/feeding?date=${today}`, { owner: sequenceOwner })).json;
  assert.equal(sequenceState.day.meals.find((meal) => meal.id === movedCompletedMeal.id).number, 2);
  assert.deepEqual(gramsByKind(sequenceState.day.totals, "remainingGrams"), beforeTimeCorrectionTotals);
  assert.deepEqual(
    gramsByKind(sequenceState.day.meals.find((meal) => !meal.completed).allocations, "plannedGrams"),
    beforeTimeCorrectionSuggestion,
  );
  const correctedTimestamp = await db.prepare(
    "SELECT completed_at FROM meal_records WHERE id = ?",
  ).bind(movedCompletedMeal.id).first();
  assert.equal(correctedTimestamp.completed_at, `${today}T08:17:43.000+02:00`);

  const sequenceWithAdded = await post({ action: "add_extra_meal", date: today }, sequenceOwner);
  const addedSequenceMeal = sequenceWithAdded.day.meals.find((meal) => meal.extra);
  const stillOpenId = sequenceWithAdded.day.meals.find((meal) => !meal.completed && !meal.extra).id;
  await post({
    action: "save_meal",
    mealId: addedSequenceMeal.id,
    actuals: addedSequenceMeal.allocations.map((item) => ({ feedItemId: item.id, actualGrams: item.plannedGrams })),
  }, sequenceOwner);
  sequenceState = (await request(`/api/feeding?date=${today}`, { owner: sequenceOwner })).json;
  assert.equal(sequenceState.day.meals.find((meal) => meal.id === addedSequenceMeal.id).number, 3);
  assert.equal(sequenceState.day.meals.find((meal) => meal.id === stillOpenId).number, 4);
  assert.deepEqual(sequenceState.day.meals.map((meal) => meal.number), [1, 2, 3, 4]);

  const deletedEntry = await post({ action: "delete_meal_entry", mealId: movedCompletedMeal.id }, sequenceOwner);
  assert.ok(!deletedEntry.day.meals.some((meal) => meal.id === movedCompletedMeal.id));
  assert.deepEqual(deletedEntry.day.meals.map((meal) => meal.number), [1, 2, 3]);
  assert.equal(deletedEntry.day.mealCount, 3);
  assert.deepEqual(gramsByKind(deletedEntry.day.totals, "remainingGrams"), { wet: 40, dry: 12.5 });
  assert.deepEqual(
    gramsByKind(deletedEntry.day.meals.find((meal) => !meal.completed).allocations, "plannedGrams"),
    { wet: 40, dry: 12.5 },
  );
  const removedRecord = await db.prepare("SELECT id FROM meal_records WHERE id = ?").bind(movedCompletedMeal.id).first();
  const removedAllocations = await db.prepare(
    "SELECT COUNT(*) AS count FROM meal_allocations WHERE meal_id = ?",
  ).bind(movedCompletedMeal.id).first();
  assert.equal(removedRecord, null);
  assert.equal(Number(removedAllocations.count), 0);
  const sequenceFuture = (await request(`/api/feeding?date=${tomorrow}`, { owner: sequenceOwner })).json;
  assert.equal(sequenceFuture.day.mealCount, 3);
  assert.equal(sequenceFuture.day.meals.length, 3);

  const foreignEntryDelete = await request("/api/feeding", {
    method: "POST",
    owner: "other-owner",
    body: { action: "delete_meal_entry", mealId: firstSequenceMeal.id },
  });
  assert.equal(foreignEntryDelete.response.status, 400);

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
