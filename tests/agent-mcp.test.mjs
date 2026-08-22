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

test("serves the restricted Hermes MCP tools for feeding, corrections, and medication", async (t) => {
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

  const unauthorized = await miniflare.dispatchFetch("http://localhost/api/hermes-mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), {
    error: "missing_access_token",
    error_description: "Der Bearer-Zugangsschlüssel fehlt.",
  });
  assert.match(unauthorized.headers.get("www-authenticate"), /error="missing_access_token"/);

  const malformedAuthorization = await miniflare.dispatchFetch("http://localhost/api/hermes-mcp", {
    method: "POST",
    headers: {
      authorization: "Basic nicht-erlaubt",
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/list", params: {} }),
  });
  assert.equal(malformedAuthorization.status, 401);
  assert.deepEqual(await malformedAuthorization.json(), {
    error: "invalid_authorization_header",
    error_description: "Die Authorization-Kopfzeile muss genau einen Bearer-Zugangsschlüssel enthalten.",
  });

  const invalidToken = await miniflare.dispatchFetch("http://localhost/api/hermes-mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer ${ROSIE_MCP_TOKEN}",
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 12, method: "tools/list", params: {} }),
  });
  assert.equal(invalidToken.status, 401);
  assert.deepEqual(await invalidToken.json(), {
    error: "invalid_access_token",
    error_description: "Der Zugangsschlüssel ist ungültig oder widerrufen.",
  });
  assert.match(invalidToken.headers.get("www-authenticate"), /error="invalid_access_token"/);

  async function mcp(id, method, params = {}) {
    const response = await miniflare.dispatchFetch("http://localhost/api/hermes-mcp", {
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
  assert.deepEqual(tools.tools.map((tool) => tool.name), [
    "rosie_tag_anzeigen",
    "rosie_futter_eintragen",
    "rosie_futter_korrigieren",
    "rosie_medikament_dokumentieren",
  ]);

  const day = await mcp(4, "tools/call", {
    name: "rosie_tag_anzeigen",
    arguments: {},
  });
  assert.equal(day.structuredContent.meals.filter((meal) => meal.status === "open").length, 2);
  assert.deepEqual(day.structuredContent.meals[0].medications, [{
    name: "Agent Medikament",
    targetAmount: "½",
    unit: "Tablette",
    given: false,
    givenAt: null,
  }]);

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

  const correctionArguments = {
    meal_number: 1,
    time: "09:22",
    amounts: [
      { food_name: "Agent Nassfutter", grams: 50 },
      { food_name: "Agent Trockenfutter", grams: 7 },
    ],
    idempotency_key: "agent-qa-correction-0001",
  };
  const corrected = await mcp(7, "tools/call", {
    name: "rosie_futter_korrigieren",
    arguments: correctionArguments,
  });
  assert.equal(corrected.structuredContent.status, "corrected");
  assert.match(corrected.content[0].text, /Korrigiert: 09:22 Uhr/);
  const repeatedCorrection = await mcp(8, "tools/call", {
    name: "rosie_futter_korrigieren",
    arguments: correctionArguments,
  });
  assert.equal(repeatedCorrection.structuredContent.status, "already_corrected");
  const incompleteCorrection = await mcp(81, "tools/call", {
    name: "rosie_futter_korrigieren",
    arguments: {
      meal_number: 1,
      time: "09:30",
      amounts: [{ food_name: "Agent Nassfutter", grams: 55 }],
      idempotency_key: "agent-qa-correction-incomplete",
    },
  });
  assert.equal(incompleteCorrection.isError, true);
  assert.match(incompleteCorrection.content[0].text, /alle Futtersorten/i);

  const medicationArguments = {
    meal_number: 1,
    medication_name: "Agent Medikament",
    given: true,
    idempotency_key: "agent-qa-medication-0001",
  };
  const medicationGiven = await mcp(9, "tools/call", {
    name: "rosie_medikament_dokumentieren",
    arguments: medicationArguments,
  });
  assert.equal(medicationGiven.structuredContent.status, "documented");
  assert.equal(medicationGiven.structuredContent.changed, true);
  assert.equal(medicationGiven.structuredContent.given, true);
  assert.equal(medicationGiven.structuredContent.targetAmount, "½");
  const repeatedMedication = await mcp(10, "tools/call", {
    name: "rosie_medikament_dokumentieren",
    arguments: medicationArguments,
  });
  assert.equal(repeatedMedication.structuredContent.status, "already_documented");

  const medicationUndone = await mcp(11, "tools/call", {
    name: "rosie_medikament_dokumentieren",
    arguments: {
      ...medicationArguments,
      given: false,
      idempotency_key: "agent-qa-medication-0002",
    },
  });
  assert.equal(medicationUndone.structuredContent.given, false);
  assert.equal(medicationUndone.structuredContent.changed, true);
  const unplannedMedication = await mcp(12, "tools/call", {
    name: "rosie_medikament_dokumentieren",
    arguments: {
      meal_number: 1,
      medication_name: "Nicht geplant",
      given: true,
      idempotency_key: "agent-qa-medication-unplanned",
    },
  });
  assert.equal(unplannedMedication.isError, true);
  assert.match(unplannedMedication.content[0].text, /nicht geplant/i);

  const stateResponse = await miniflare.dispatchFetch("http://localhost/state");
  const state = await stateResponse.json();
  assert.equal(state.day.meals.filter((meal) => meal.completed).length, 1);
  assert.equal(state.day.meals.find((meal) => meal.completed).recordedVia, "hermes");
  assert.equal(state.day.totals.find((item) => item.kind === "wet").actualGrams, 50);
  assert.equal(state.day.totals.find((item) => item.kind === "dry").actualGrams, 7);
  assert.equal(new Intl.DateTimeFormat("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Europe/Berlin",
  }).format(new Date(state.day.meals.find((meal) => meal.completed).completedAt)), "09:22");
  assert.equal(state.day.meals[0].medications[0].given, false);
});
