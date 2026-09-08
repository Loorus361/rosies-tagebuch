import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
test("flexible dry exchange, calorie exchange, corrections, history and owner isolation", async t => {
  const mf = new Miniflare({ modules: true, scriptPath: fileURLToPath(new URL("../.wrangler/feeding-flow-worker.mjs", import.meta.url)), d1Databases: ["DB"] });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
  for (const name of (await readdir(new URL("../drizzle/", import.meta.url))).filter(n => n.endsWith(".sql")).sort()) {
    for (const sql of (await readFile(new URL(`../drizzle/${name}`, import.meta.url), "utf8")).split("--> statement-breakpoint").filter(s => s.trim())) await db.prepare(sql).run();
  }
  async function request(body, owner = "energy-owner", status = 200) {
    const response = await mf.dispatchFetch(`http://localhost/api/feeding?date=${today}`, {
      method: body ? "POST" : "GET", headers: { "content-type": "application/json", "oai-authenticated-user-id": owner }, body: body ? JSON.stringify(body) : undefined,
    });
    const json = await response.json();
    assert.equal(response.status, status, JSON.stringify(json));
    return body ? json.state : json;
  }
  await request({ action: "create_item", name: "Platinum Test", kind: "dry" });
  await request({ action: "create_item", name: "Royal Canin Test", kind: "dry" });
  let state = await request({ action: "create_item", name: "Nass Test", kind: "wet" });
  const [a,b,c] = state.feedItems;
  state = await request({ action: "save_plan", effectiveDate: today, mealCount: 3, items: [a,b,c].map(f => ({ feedItemId: f.id, dailyGrams: 100 })) });
  const planId = state.currentPlan.id;
  const first = state.day.meals[0].id;
  const actuals = (x,y,z) => [a,b,c].map((f,i) => ({ feedItemId: f.id, actualGrams: [x,y,z][i] }));
  state = await request({ action: "save_meal", mealId: first, actuals: actuals(150,0,0) });
  assert.deepEqual(state.day.totals.map(f => f.remainingGrams), [0,50,100]);
  assert.equal(state.day.balance.mode, "approximate");
  assert.deepEqual([a,b,c].map(food => state.day.meals[1].allocations.find(f => f.id === food.id).plannedGrams), [0,25,50]);
  await request({ action: "save_energy", items: [{ feedItemId: a.id, kcalPer100g: 400 }] }, "intruder", 400);
  for (const invalid of [-1,0,1001,"invalid",true,"98,5.2","1,2,3"]) await request({ action: "save_energy", items: [{ feedItemId: a.id, kcalPer100g: invalid }] }, undefined, 400);
  // Both decimal separators survive saving, including precision beyond one decimal place.
  for (const value of ["98,55", "98.55"]) {
    state = await request({ action: "save_energy", items: [{ feedItemId: c.id, kcalPer100g: value }] });
    assert.equal(state.feedItems.find(f => f.id === c.id).kcalPer100g, 98.55);
  }
  // Missing calories for one food must not disable known wet/dry exchanges.
  state = await request({ action: "save_energy", items: [{ feedItemId: a.id, kcalPer100g: 400 }, { feedItemId: c.id, kcalPer100g: 100 }] });
  assert.equal(state.day.balance.mode, "approximate");
  assert.deepEqual(state.day.totals.map(f => f.remainingGrams), [0,100,0]);
  state = await request({ action: "save_meal", mealId: first, actuals: actuals(0,0,300) });
  assert.deepEqual(state.day.totals.map(f => f.remainingGrams), [50,100,0]);
  state = await request({ action: "save_meal", mealId: first, actuals: actuals(150,0,0) });
  state = await request({ action: "save_energy", items: [a,b,c].map((f,i) => ({ feedItemId: f.id, kcalPer100g: [400,400,100][i] })) });
  assert.equal(state.currentPlan.id, planId);
  assert.deepEqual(state.day.balance, { mode: "energy", targetKcal: 900, actualKcal: 600 });
  const firstSnapshot = state.day.meals[0];
  state = await request({ action: "save_meal", mealId: state.day.meals[1].id, actuals: actuals(0,0,300) });
  assert.equal(state.day.balance.actualKcal, 900);
  assert.deepEqual(state.day.totals.map(f => f.remainingGrams), [0,0,0]);
  assert.deepEqual(state.day.meals[0], firstSnapshot);
  state = await request({ action: "save_meal", mealId: first, actuals: actuals(100,0,0) });
  assert.equal(state.day.balance.actualKcal, 700);
  assert.deepEqual(state.day.totals.map(f => f.remainingGrams), [0,50,0]);
  state = await request({ action: "add_extra_meal", date: today });
  assert.deepEqual(state.day.meals.filter(m => !m.completed).map(m => m.allocations.find(f => f.id === b.id).plannedGrams), [25,25]);
  state = await request({ action: "remove_meal", mealId: state.day.meals.at(-1).id });
  assert.equal(state.day.meals.at(-1).allocations.find(f => f.id === b.id).plannedGrams, 50);
  state = await request({ action: "delete_meal_entry", mealId: state.day.meals[1].id });
  assert.equal(state.day.balance.actualKcal, 400);
  assert.deepEqual(state.day.totals.map(f => f.remainingGrams), [0,100,100]);
  const yesterday = new Date(`${today}T12:00:00Z`); yesterday.setUTCDate(yesterday.getUTCDate()-1);
  const date = yesterday.toISOString().slice(0,10);
  // A materialized prior day uses only values effective at that date.
  await db.prepare("UPDATE plan_versions SET effective_date = ? WHERE id = ?").bind(date,planId).run();
  const historical = await mf.dispatchFetch(`http://localhost/api/feeding?date=${date}`, { headers: { "oai-authenticated-user-id": "energy-owner" } });
  const past = await historical.json();
  assert.equal(past.day.balance.mode, "approximate");
  state = await request({ action: "save_energy", items: [{ feedItemId: a.id, kcalPer100g: 350 }] });
  assert.equal(state.day.balance.targetKcal, 850);
  assert.equal(state.feedItems.find(f => f.id === a.id).kcalPer100g, 350);
  const pastAgain = await (await mf.dispatchFetch(`http://localhost/api/feeding?date=${date}`, { headers: { "oai-authenticated-user-id": "energy-owner" } })).json();
  assert.deepEqual(pastAgain.day, past.day);
  state = await request({ action: "save_energy", items: [{ feedItemId: a.id, kcalPer100g: "" }] });
  assert.equal(state.day.balance.mode, "approximate");
  assert.equal(state.feedItems.find(f => f.id === a.id).kcalPer100g, null);
});
