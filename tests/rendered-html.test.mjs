import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";

const ownerHeaders = {
  "oai-authenticated-user-id": "test-owner",
  "oai-authenticated-user-email": "carlos@example.test",
  "oai-authenticated-user-full-name": "Carlos",
  "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
};
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

async function runtime(t) {
  const root = fileURLToPath(new URL("../dist/server/", import.meta.url));
  const files = (await readdir(root, { recursive: true })).filter(name => /\.m?js$/.test(name) && name !== "index.js");
  const mf = new Miniflare({
    modules: ["index.js", ...files].map(name => ({ type: "ESModule", path: `${root}${name}` })),
    modulesRoot: fileURLToPath(new URL("../dist/server/", import.meta.url)),
    modulesRules: [{ type: "ESModule", include: ["**/*.js", "**/*.mjs"] }],
    compatibilityDate: "2026-05-15",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: ["DB"],
  });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
  for (const name of ["0000_loose_sabra.sql", "0001_rare_emma_frost.sql", "0002_blushing_purifiers.sql", "0003_married_william_stryker.sql"]) {
    const sql = await readFile(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
    for (const statement of sql.split("--> statement-breakpoint").map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  return { mf, db };
}

async function post(mf, body) {
  const response = await mf.dispatchFetch("http://localhost/api/feeding", {
    method: "POST", headers: { ...ownerHeaders, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return response.json();
}

test("renders real initial data and returns updated data directly after saving", async t => {
  const { mf } = await runtime(t);
  const item = await post(mf, { action: "create_item", name: "Testfutter", kind: "dry" });
  assert.equal(item.state.feedItems[0].name, "Testfutter");
  const plan = await post(mf, { action: "save_plan", effectiveDate: today, mealCount: 3, items: [{ feedItemId: item.state.feedItems[0].id, dailyGrams: 90 }] });
  const meal = plan.state.day.meals[0];
  const saved = await post(mf, { action: "save_meal", mealId: meal.id, actuals: [{ feedItemId: item.state.feedItems[0].id, actualGrams: 100 }] });
  assert.equal(saved.state.day.meals[0].completed, true);
  assert.equal(saved.state.day.totals[0].actualGrams, 100);
  assert.ok(saved.state.lastMealAt);
  const response = await mf.dispatchFetch("http://localhost/", { headers: { ...ownerHeaders, accept: "text/html" } });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>Rosies Tagebuch · Fütterung<\/title>/i);
  assert.match(html, /Testfutter/);
  assert.match(html, /10 g über Tagesvorgabe/);
  assert.doesNotMatch(html, /Rosies Fütterung wird geladen/);
});

test("reports a committed write separately from a failed refresh", async t => {
  const { mf, db } = await runtime(t);
  await db.prepare("DROP TABLE medications").run();
  const saved = await post(mf, { action: "create_item", name: "Schon gespeichert", kind: "dry" });
  assert.equal(saved.ok, true);
  assert.match(saved.refreshError, /^Gespeichert\./);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM feed_items").first()).count, 1);
});

test("redirects anonymous visitors and rejects other accounts", async t => {
  const { mf } = await runtime(t);
  const anonymous = await mf.dispatchFetch("http://localhost/", { redirect: "manual" });
  assert.ok([302, 303, 307, 308].includes(anonymous.status));
  assert.match(anonymous.headers.get("location"), /^\/signin-with-chatgpt\?return_to=/);
  const other = await mf.dispatchFetch("http://localhost/", { headers: { ...ownerHeaders, "oai-authenticated-user-id": "someone-else" } });
  assert.equal(other.status, 404);
  const api = await mf.dispatchFetch("http://localhost/api/feeding", { headers: { ...ownerHeaders, "oai-authenticated-user-id": "someone-else" } });
  assert.equal(api.status, 403);
});
