import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

const migrations = [
  "0000_loose_sabra.sql",
  "0001_rare_emma_frost.sql",
  "0002_blushing_purifiers.sql",
  "0003_married_william_stryker.sql",
];

test("serves the restricted Hermes MCP tools and prevents duplicate feedings", async (t) => {
  const miniflare = new Miniflare({
    modules: true,
    scriptPath: fileURLToPath(new URL("../.wrangler/agent-mcp-worker.mjs", import.meta.url)),
    d1Databases: ["DB"],
    compatibilityFlags: ["streams_enable_constructors"],
  });
  t.after(() => miniflare.dispose());
  const db = await miniflare.getD1Database("DB");
  for (const migrationName of migrations) {
    const migration = await readFile(new URL(`../drizzle/${migrationName}`, import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }

  const seedResponse = await miniflare.dispatchFetch("http://localhost/seed", { method: "POST" });
  const { token } = await seedResponse.json();
  assert.match(token, /^rosie_[a-f0-9]{64}$/);

  const unauthorized = await miniflare.dispatchFetch("http://localhost/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(unauthorized.status, 401);

  async function mcp(id, method, params = {}) {
    const response = await miniflare.dispatchFetch("http://localhost/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    const responseText = await response.text();
    const json = response.headers.get("content-type")?.includes("text/event-stream")
      ? JSON.parse(responseText.split("\n").filter((line) => line.startsWith("data: ")).at(-1).slice(6))
      : JSON.parse(responseText);
    assert.equal(response.status, 200, JSON.stringify(json));
    assert.equal(json.error, undefined, JSON.stringify(json));
    return json.result;
  }

  const initialized = await mcp(2, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "qa-hermes", version: "1.0.0" },
  });
  assert.equal(initialized.serverInfo.name, "Rosies Tagebuch");

  const tools = await mcp(3, "tools/list");
  assert.deepEqual(tools.tools.map((tool) => tool.name), ["rosie_tag_anzeigen", "rosie_futter_eintragen"]);

  const day = await mcp(4, "tools/call", {
    name: "rosie_tag_anzeigen",
    arguments: {},
  });
  assert.equal(day.structuredContent.meals.filter((meal) => meal.status === "open").length, 2);

  const recordArguments = {
    time: "08:17",
    amounts: [
      { food_name: "Agent Nassfutter", grams: 45 },
      { food_name: "Agent Trockenfutter", grams: 8 },
    ],
    create_extra_if_needed: false,
    idempotency_key: "agent-qa-message-0001",
  };
  const recorded = await mcp(5, "tools/call", {
    name: "rosie_futter_eintragen",
    arguments: recordArguments,
  });
  assert.equal(recorded.structuredContent.status, "recorded");
  assert.match(recorded.content[0].text, /45 g Agent Nassfutter/);
  assert.equal(new Intl.DateTimeFormat("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Europe/Berlin",
  }).format(new Date(recorded.structuredContent.completedAt)), "08:17");

  const repeated = await mcp(6, "tools/call", {
    name: "rosie_futter_eintragen",
    arguments: recordArguments,
  });
  assert.equal(repeated.structuredContent.status, "already_recorded");

  const stateResponse = await miniflare.dispatchFetch("http://localhost/state");
  const state = await stateResponse.json();
  assert.equal(state.day.meals.filter((meal) => meal.completed).length, 1);
  assert.equal(state.day.meals.find((meal) => meal.completed).recordedVia, "hermes");
  assert.equal(state.day.totals.find((item) => item.kind === "wet").actualGrams, 45);
  assert.equal(state.day.totals.find((item) => item.kind === "dry").actualGrams, 8);
});
